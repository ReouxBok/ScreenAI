import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, savMessages } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { savDerivedCostQuote } from "../derived-budget";
import type { SavGeminiMetadata } from "../gemini-response";
import { SAV_AI_BUDGET, savAiCancellationCode, withSavAiBudget } from "../gemini-transport";
import { planSavIntake } from "./engine";
import type { EnginePolicy, IntakePlan, ReadResult } from "./engine-types";
import { createSavIntakeHubspotReaders, type SavIntakeCrmReaders } from "./hubspot-readers";
import { createIntakeModelDispatcher, type IntakeDispatchDiagnostic } from "./model-dispatch";
import { comparisonValidationDiagnostics } from "./comparison-diagnostics";
import { createSavIntakeSemanticReaders, type IntakeModelTrace } from "./model-readers";
import { savIntakeRuntimeConfig, type IntakeRuntimeConfig } from "./runtime-contract";
import { savIntakeSourceSnapshot } from "./runtime-store";
import { readIntakeOtherRules } from "./other-routing";
import { qualifyRuntimeCandidate } from "./other-routing-runtime";
import { createSavIntakeSimpleReaders, readIntakeSimpleContext } from "./simple-readers";

/** Separate comparison campaign of the current and the single-call reader on a frozen list of
 * stored dossiers. It never runs on the live mail path: an administrator launches small batches.
 * Read-only CRM, no executor, no live ledger, attempts, runs or call policy. Its own caps and its
 * own append-only ledger (audit events). OFF unless SAV_INTAKE_COMPARISON_JSON is configured. */
export const SAV_INTAKE_COMPARISON_REVISION = "sav-intake-comparison-2026-10-28.v3";
const campaignSchema = z.object({ campaignId: z.string().regex(/^[a-z0-9-]{1,64}$/), messageIds: z.array(z.uuid()).min(1).max(100),
  maxNanoUsd: z.number().int().min(1).max(50_000_000_000), until: z.iso.datetime() }).strict()
  .refine(c => new Set(c.messageIds).size === c.messageIds.length, "duplicate message");
export type SavIntakeComparisonConfig = z.infer<typeof campaignSchema>;
/** Absent, invalid or expired: OFF. Re-checked at every reservation, so spending stops at `until`. */
export function savIntakeComparisonConfig(env: Record<string, string | undefined>, now = new Date()): SavIntakeComparisonConfig | null {
  if (!env.SAV_INTAKE_COMPARISON_JSON) return null;
  try { const config = campaignSchema.parse(JSON.parse(env.SAV_INTAKE_COMPARISON_JSON)); return Date.parse(config.until) > now.getTime() ? config : null; }
  catch { console.warn("sav_intake_comparison", { error: "SAV_INTAKE_COMPARISON_CONFIGURATION_INVALID" }); return null; }
}

const ACTION = "sav_intake_comparison", ENTITY = "sav_intake_comparison", LOCK = sql`select pg_advisory_xact_lock(hashtext('sav-intake-comparison-v1'))`;
type Meta = Record<string, string | number | boolean | null>;
type Reader = Pick<ReturnType<typeof requireDb>, "select">;
const events = async (db: Reader, campaignId: string) => (await db.select({ metadata: auditLogs.technicalMetadata }).from(auditLogs)
  .where(and(eq(auditLogs.action, ACTION), eq(auditLogs.entityType, ENTITY), sql`${auditLogs.technicalMetadata}->>'campaignId' = ${campaignId}`))).map(r => r.metadata as Meta);
const append = (db: Pick<ReturnType<typeof requireDb>, "insert">, metadata: Meta) =>
  db.insert(auditLogs).values({ actorEmail: "system", action: ACTION, entityType: ENTITY, entityId: String(metadata.callId ?? metadata.claimId ?? randomUUID()), technicalMetadata: metadata });

/** Spend of one campaign, independent of the order events are returned in: reservations first,
 * then settlements. A call costs its reservation unless settled; any uncertain settlement keeps it. */
export function savIntakeComparisonSpend(all: readonly Meta[]) {
  const calls = new Map<string, { reserved: number; settled: number[]; uncertain: boolean }>();
  for (const e of all) if (e.event === "reserved" && typeof e.callId === "string") calls.set(e.callId, { reserved: Number(e.reservedNanoUsd) || 0, settled: [], uncertain: false });
  for (const e of all) {
    const call = typeof e.callId === "string" ? calls.get(e.callId) : undefined;
    if (!call || e.event !== "settled") continue;
    if (e.state === "settled") call.settled.push(Number(e.chargedNanoUsd) || 0); else call.uncertain = true;
  }
  return [...calls.values()].reduce((sum, c) => sum + (c.uncertain || !c.settled.length ? c.reserved : Math.max(...c.settled)), 0);
}
/** Atomic, durable claim of one dossier for one campaign: two workers can never both pay for it. */
export async function claimSavIntakeComparison(campaignId: string, messageId: string) {
  return requireDb().transaction(async tx => {
    await tx.execute(LOCK);
    if ((await events(tx, campaignId)).some(e => e.event === "claimed" && e.messageId === messageId)) return null;
    const claimId = randomUUID();
    await append(tx, { campaignId, messageId, claimId, event: "claimed", at: new Date().toISOString() });
    return claimId;
  });
}
/** Reserve one dispatch: the campaign is re-validated now (schema, list, `until`), then its money cap. */
export async function reserveSavIntakeComparisonCall(env: () => Record<string, string | undefined>, campaignId: string, messageId: string, claimId: string, requestHash: string, model: string, signal?: AbortSignal) {
  const active = () => { const code = savAiCancellationCode(signal); if (code) throw Error(code); };
  active();
  return requireDb().transaction(async tx => {
    await tx.execute(LOCK);
    active();
    const config = savIntakeComparisonConfig(env());
    if (!config || config.campaignId !== campaignId || !config.messageIds.includes(messageId)) throw Error("SAV_INTAKE_COMPARISON_EXPIRED");
    const price = savDerivedCostQuote(model, 8192);
    if (savIntakeComparisonSpend(await events(tx, campaignId)) + price.reservedNanoUsd > config.maxNanoUsd) throw Error("SAV_INTAKE_COMPARISON_BUDGET_EXHAUSTED");
    active();
    const callId = randomUUID();
    await append(tx, { campaignId, messageId, claimId, callId, event: "reserved", requestHash, reservedNanoUsd: price.reservedNanoUsd });
    return { id: callId, cached: null };
  });
}
/** Grouped plan check on the campaign's own ledger and caps (never the live ledger): every group of
 * the plan must fit before the first one is dispatched. Read-only; reservations re-check each call. */
export async function assertSavIntakeComparisonPlan(env: () => Record<string, string | undefined>, campaignId: string, messageId: string, hashes: readonly string[], model: string, signal?: AbortSignal) {
  const active = () => { const code = savAiCancellationCode(signal); if (code) throw Error(code); };
  active();
  if (!hashes.length || hashes.length > 3 || new Set(hashes).size !== hashes.length) throw Error("SAV_INTAKE_RUNTIME_DISPATCH_REJECTED");
  await requireDb().transaction(async tx => {
    await tx.execute(LOCK);
    active();
    const config = savIntakeComparisonConfig(env());
    if (!config || config.campaignId !== campaignId || !config.messageIds.includes(messageId)) throw Error("SAV_INTAKE_COMPARISON_EXPIRED");
    if (savIntakeComparisonSpend(await events(tx, campaignId)) + hashes.length * savDerivedCostQuote(model, 8192).reservedNanoUsd > config.maxNanoUsd) throw Error("SAV_INTAKE_COMPARISON_BUDGET_EXHAUSTED");
  });
}
/** Same validity rule as the live ledger; a reservation stays reconcilable after the campaign ends. */
export function settleSavIntakeComparisonCall(campaignId: string) {
  return async (callId: string, metadata?: SavGeminiMetadata, result?: unknown, unbilledProviderStatus?: number) => {
    void result;
    const { inputTokens: i, outputTokens: o, thoughtTokens: t, totalTokens: total } = metadata ?? {};
    const valid = [i, o, t, total].every(n => Number.isSafeInteger(n) && Number(n) >= 0) && Number(i) >= 1 && Number(i) <= 1_048_576
      && Number(o) + Number(t) <= 8192 && Number(i) + Number(o) + Number(t) === total;
    const unbilled = !valid && unbilledProviderStatus !== undefined && (unbilledProviderStatus === 429 || unbilledProviderStatus >= 500 && unbilledProviderStatus <= 599);
    await append(requireDb(), { campaignId, callId, event: "settled", state: valid || unbilled ? "settled" : "uncertain", chargedNanoUsd: valid ? Number(i) * 750 + (Number(o) + Number(t)) * 3750 : 0 });
    return valid || unbilled;
  };
}

/** One frozen CRM view shared by both readers: captured once, then served only from the capture.
 * Anything a reader needs that was not captured is a recorded coverage miss, never a fresh read. */
function frozenCrm(live: SavIntakeCrmReaders) {
  const captured = new Map<string, Promise<unknown>>(), misses = new Set<string>(), served = new Set<string>();
  const wrap = <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>, frozen: () => boolean) => async (...args: A): Promise<R> => {
    const key = `${name}:${String(args[0])}`;
    if (frozen()) served.add(key);
    if (captured.has(key)) return captured.get(key) as Promise<R>;
    if (frozen()) { misses.add(key); return { status: "failed", data: null, observedAt: new Date().toISOString() } as R; }
    const value = fn(...args); captured.set(key, value); return value;
  };
  let isFrozen = false;
  const build = (frozen: () => boolean): SavIntakeCrmReaders => ({ findContactsByEmail: wrap("contacts", live.findContactsByEmail, frozen),
    directAssociations: wrap("associations", live.directAssociations, frozen), getContact: wrap("contact", live.getContact, frozen),
    ticketsForContact: wrap("tickets", live.ticketsForContact, frozen), ticketHistory: wrap("history", live.ticketHistory, frozen) });
  return { capture: build(() => false), frozen: build(() => isFrozen), freeze: async () => {
    isFrozen = true;
    const answers = await Promise.all([...captured].sort(([a], [b]) => a.localeCompare(b)).map(async ([key, value]) => [key, await value.catch(() => null)] as const));
    return createHash("sha256").update(JSON.stringify(answers.map(([key, value]) => [key, (value as ReadResult<unknown> | null)?.status ?? "error", (value as ReadResult<unknown> | null)?.data ?? null]))).digest("hex");
  }, misses,
  /** Captured reads a reader actually used that were not complete: a missing record is not a real
   * absence. A complete answer with zero record (customer unknown) stays comparable. */
  failedUsed: async () => {
    const out: string[] = [];
    for (const key of served) {
      const value = await (captured.get(key) ?? Promise.resolve(null)).catch(() => null) as ReadResult<unknown> | null;
      if (captured.has(key) && value?.status !== "complete") out.push(`crm_${value?.status ?? "error"}:${key.split(":")[0]}`);
    }
    return out;
  } };
}

export function intakePlanSummary(plan?: IntakePlan) {
  if (!plan) return null;
  const d = plan.decision.disposition;
  return { classification: plan.decision.classification, disposition: d.kind, operation: d.kind === "ticket" ? d.target.operation : null,
    ticketId: d.kind === "ticket" && d.target.operation !== "create" ? d.target.ticketId : null, contactId: d.kind === "ticket" ? d.target.contactId : null,
    reasons: d.kind === "collect_context" ? [...d.reasons].sort() : [], mutations: plan.steps.map(s => s.mutation).sort(), progress: plan.progress.kind,
    newTicketTitle: plan.newTicket?.title ?? null };
}
type Summary = NonNullable<ReturnType<typeof intakePlanSummary>>;
type Side = { summary: Summary | null; technical: string | null; uncertain: boolean; calls: number;
  diagnostics?: { requests: IntakeDispatchDiagnostic[]; failures: ReturnType<typeof comparisonValidationDiagnostics>; dispatches: number; httpResponses: number } };
/** Judgement is compared only when both sides worked on the same complete input; a technical
 * failure of either side is technical evidence, never a divergence of judgement. */
export function compareIntakeSides(current: Side, simple: Side, coverage: readonly string[]) {
  if (coverage.length) return { verdict: "non_comparable" as const, differences: [...coverage] };
  if (current.technical || simple.technical || !current.summary || !simple.summary)
    return { verdict: "incomplete" as const, differences: [`current:${current.technical ?? (current.summary ? "ok" : "missing")}`, `simple:${simple.technical ?? (simple.summary ? "ok" : "missing")}`] };
  const keys = ["classification", "disposition", "operation", "ticketId", "contactId", "reasons", "mutations", "progress"] as const;
  const differences: string[] = keys.filter(k => JSON.stringify(current.summary![k]) !== JSON.stringify(simple.summary![k]));
  if (!differences.length && current.summary.newTicketTitle !== simple.summary.newTicketTitle) return { verdict: "identical" as const, differences: ["newTicketTitle"] };
  return { verdict: differences.length ? "divergent" as const : "identical" as const, differences };
}

async function compareOne(messageId: string, claimId: string, campaign: SavIntakeComparisonConfig, runtime: IntakeRuntimeConfig,
  env: () => Record<string, string | undefined>, network: typeof fetch) {
  const [message] = await requireDb().select().from(savMessages).where(eq(savMessages.id, messageId));
  if (!message) return { coverage: ["message_missing"], snapshotHash: null, current: null, simple: null, ...compareIntakeSides(empty, empty, ["message_missing"]) };
  const now = new Date(), snapshot = await savIntakeSourceSnapshot(requireDb(), message, now);
  const coverage: string[] = [];
  // Images are not downloaded by this runner: a dossier with attachments is not comparable here.
  if ((snapshot.body.attachments?.length ?? 0) > 0) coverage.push("attachments_not_loaded");
  // Only a dossier an approved Other rule could match depends on the Gmail-authenticated qualification
  // this runner does not perform; every other dossier is compared exactly as the live path would.
  // An unreadable or expired catalogue stops the live path before planning: no judgement here would be
  // production-equivalent, so the cause is kept and no paid call is made.
  let catalogue: ReturnType<typeof readIntakeOtherRules>;
  try { catalogue = readIntakeOtherRules(env().SAV_INTAKE_OTHER_RULES_JSON); }
  catch (error) {
    const cause = [error instanceof Error && /^SAV_[A-Z0-9_]+$/.test(error.message) ? error.message : "SAV_INTAKE_OTHER_CONFIGURATION_REQUIRED"];
    return { coverage: cause, snapshotHash: null, current: null, simple: null, ...compareIntakeSides(empty, empty, cause) };
  }
  if (catalogue && qualifyRuntimeCandidate({ mailboxId: message.mailboxId, subject: message.subject, body: { text: snapshot.body.text ?? "" } }, catalogue)) coverage.push("qualified_other_candidate");
  const policy: EnginePolicy = runtime.policy;
  const crm = frozenCrm(createSavIntakeHubspotReaders({ network: async (url, init) => network(url, { ...init, redirect: "error",
    headers: { ...Object.fromEntries(new Headers(init?.headers)), Authorization: `Bearer ${env().HUBSPOT_ACCESS_TOKEN}` } }) }));
  // Capture the superset both readers use (sender contacts, admitted links, tickets, histories), then freeze.
  // Both address spellings: the simple reader reads the raw sender, the engine its normalized form.
  for (const address of new Set([snapshot.input.message.fromEmail, snapshot.input.message.fromEmail.trim().toLowerCase()]))
    await readIntakeSimpleContext(crm.capture, address, policy, AbortSignal.timeout(30_000));
  const crmHash = await crm.freeze();
  const side = async (kind: "current" | "simple"): Promise<Side> => {
    const traces: IntakeModelTrace[] = [], controller = new AbortController(), timer = setTimeout(() => controller.abort(Error("SAV_INTAKE_COMPARISON_DEADLINE")), SAV_AI_BUDGET.durationMs);
    const dispatcher = createIntakeModelDispatcher({ config: runtime, signal: controller.signal, env, network,
      captureDiagnostics: true, ...(kind === "simple" ? { generationBudget: "single_pass" as const } : {}),
      live: async () => { if (controller.signal.aborted) throw Error("SAV_INTAKE_COMPARISON_DEADLINE"); if (!savIntakeComparisonConfig(env())) throw Error("SAV_INTAKE_COMPARISON_EXPIRED"); },
      reserve: hash => reserveSavIntakeComparisonCall(env, campaign.campaignId, messageId, claimId, hash, runtime.model, controller.signal), settle: settleSavIntakeComparisonCall(campaign.campaignId),
      preflight: hashes => assertSavIntakeComparisonPlan(env, campaign.campaignId, messageId, hashes, runtime.model, controller.signal) });
    const semantic = kind === "simple"
      ? createSavIntakeSimpleReaders({ model: runtime.model, call: dispatcher.call, crm: crm.frozen, policy, provenance: snapshot.provenance, onTrace: t => traces.push(t) })
      : createSavIntakeSemanticReaders({ model: runtime.model, call: dispatcher.call, planCalls: dispatcher.plan, provenance: snapshot.provenance, onTrace: t => traces.push(t) });
    let plan: IntakePlan | undefined, technical: string | null = null;
    try { plan = await withSavAiBudget(() => planSavIntake(structuredClone(snapshot.input), { ...crm.frozen, ...semantic }, policy, { timeoutMs: 10_000, modelTimeoutMs: SAV_AI_BUDGET.durationMs }, () => new Date())); }
    catch (error) { technical = error instanceof Error && /^SAV_[A-Z0-9_]+$/.test(error.message) ? error.message : "SAV_INTAKE_COMPARISON_FAILED"; }
    finally { try { await Promise.allSettled(dispatcher.pending); } finally { clearTimeout(timer); } }
    technical ??= savAiCancellationCode(controller.signal);
    technical ??= dispatcher.failureReason ?? traces.find(t => !t.accepted && t.errorCode)?.errorCode ?? null;
    return { summary: technical ? null : intakePlanSummary(plan), technical, uncertain: dispatcher.uncertain, calls: traces.filter(t => t.metadata).length,
      diagnostics: { requests: dispatcher.diagnostics, failures: comparisonValidationDiagnostics(traces),
        dispatches: dispatcher.diagnostics.filter(d => d.dispatched).length,
        httpResponses: dispatcher.diagnostics.filter(d => d.httpStatus !== null).length } };
  };
  const current = await side("current"), simple = await side("simple");
  coverage.push(...[...crm.misses].map(key => `crm_not_captured:${key.split(":")[0]}`), ...await crm.failedUsed());
  const snapshotHash = createHash("sha256").update(JSON.stringify([snapshot.sourceHash, crmHash])).digest("hex");
  return { coverage: [...new Set(coverage)], snapshotHash, current, simple, ...compareIntakeSides(current, simple, [...new Set(coverage)]) };
}
const empty: Side = { summary: null, technical: null, uncertain: false, calls: 0 };

/** One bounded batch: the next unclaimed dossiers of the frozen list, one at a time. A claim
 * without a result (worker interrupted) is reported as interrupted and never re-sent automatically. */
export async function runSavIntakeComparisonBatch(options: { env?: () => Record<string, string | undefined>; network?: typeof fetch; limit?: number } = {}) {
  const env = options.env ?? (() => process.env), network = options.network ?? fetch, limit = Math.min(5, Math.max(1, options.limit ?? 3));
  const campaign = savIntakeComparisonConfig(env()), runtime = savIntakeRuntimeConfig(env());
  if (!campaign || !runtime) return { skipped: "off" as const };
  const done: { messageId: string; verdict: string }[] = [];
  for (const messageId of campaign.messageIds) {
    if (done.length >= limit) break;
    const claimId = await claimSavIntakeComparison(campaign.campaignId, messageId);
    if (!claimId) continue;
    let result: Awaited<ReturnType<typeof compareOne>> | { verdict: "incomplete"; differences: string[]; coverage: string[]; snapshotHash: null; current: null; simple: null };
    try { result = await compareOne(messageId, claimId, campaign, runtime, env, network); }
    catch (error) { result = { verdict: "incomplete", differences: [error instanceof Error && /^SAV_[A-Z0-9_]+$/.test(error.message) ? error.message : "SAV_INTAKE_COMPARISON_FAILED"], coverage: [], snapshotHash: null, current: null, simple: null }; }
    await append(requireDb(), { campaignId: campaign.campaignId, messageId, claimId, event: "result", verdict: result.verdict,
      payload: encryptSavPayload({ revision: SAV_INTAKE_COMPARISON_REVISION, at: new Date().toISOString(), ...result }) });
    done.push({ messageId, verdict: result.verdict });
  }
  return { campaignId: campaign.campaignId, compared: done };
}

/** Administrator report of one campaign: every listed dossier with its state, verdicts with
 * denominators, technical outcome per side, spend. Contains generated ticket titles (admin only). */
export async function readSavIntakeComparisonReport(env: () => Record<string, string | undefined> = () => process.env) {
  const campaign = savIntakeComparisonConfig(env()) ?? (() => { try { return campaignSchema.parse(JSON.parse(env().SAV_INTAKE_COMPARISON_JSON ?? "")); } catch { return null; } })();
  if (!campaign) return { configured: false as const };
  const all = await events(requireDb(), campaign.campaignId);
  const rows = campaign.messageIds.map(messageId => {
    const claimed = all.some(e => e.event === "claimed" && e.messageId === messageId), result = all.find(e => e.event === "result" && e.messageId === messageId);
    const detail = result && typeof result.payload === "string" ? decryptSavPayload<Record<string, unknown>>(result.payload) : null;
    return { messageId, state: result ? "done" : claimed ? "interrupted" : "pending", verdict: (result?.verdict as string | undefined) ?? null, detail };
  });
  const count = (verdict: string) => rows.filter(r => r.verdict === verdict).length;
  return { configured: true as const, revision: SAV_INTAKE_COMPARISON_REVISION, campaignId: campaign.campaignId, until: campaign.until,
    denominators: { listed: rows.length, done: rows.filter(r => r.state === "done").length, interrupted: rows.filter(r => r.state === "interrupted").length, pending: rows.filter(r => r.state === "pending").length },
    verdicts: { identical: count("identical"), divergent: count("divergent"), incomplete: count("incomplete"), non_comparable: count("non_comparable") },
    spend: { nanoUsd: savIntakeComparisonSpend(all), maxNanoUsd: campaign.maxNanoUsd }, rows };
}
