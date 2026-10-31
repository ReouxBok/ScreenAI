import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, savMessages } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { savDerivedCostQuote } from "../derived-budget";
import type { SavGeminiMetadata } from "../gemini-response";
import { SAV_AI_BUDGET, savAiCancellationCode, withSavAiBudget } from "../gemini-transport";
import { unbilledProviderStatus as isUnbilledProviderStatus } from "./model-usage";
import { planSavIntake } from "./engine";
import type { EnginePolicy, IntakeAdapters, IntakePlan, ReadResult } from "./engine-types";
import { createSavIntakeHubspotReaders, type SavIntakeCrmReaders } from "./hubspot-readers";
import { createIntakeModelDispatcher, intakeDispatchCounts, type IntakeDispatchDiagnostic } from "./model-dispatch";
import { comparisonValidationDiagnostics } from "./comparison-diagnostics";
import { createSavIntakeSemanticReaders, SAV_INTAKE_MODEL_REVISION, type IntakeModelTrace, type IntakeValidatedEvidence, type SavIntakeSemanticReaders } from "./model-readers";
import { savIntakeRuntimeConfig, type IntakeRuntimeConfig } from "./runtime-contract";
import { savIntakeSourceSnapshot } from "./runtime-store";
import { readIntakeOtherRules } from "./other-routing";
import { qualifyRuntimeCandidate } from "./other-routing-runtime";
import { createSavIntakeSimpleReaders, readIntakeSimpleContext, SAV_INTAKE_SIMPLE_REVISION } from "./simple-readers";
import { SAV_INTAKE_DECLARED_ADDRESS_CAP, savIntakeDeclaredAddressCandidates } from "./registration-declaration";
import { intakeTicketDescription, intakeUnreadAttachmentNotice } from "./ticket-description";
import { savAttachmentInventorySchema } from "../attachment-contract";
import {
  assembleReaderEvidence, boundReaderEvidenceCiphertext, commonOversizeReaderEvidence, comparisonCommonEvidence, comparisonSideEvidence, comparisonSideTiming,
  intakeMutationExpectations, readerEvidenceManifestSchema, readerEvidenceQualification, savBoundedJsonBytes, savComparisonSnapshotHash, savFrozenCrmHash,
  SAV_READER_EVIDENCE_LIMITS, unavailableReaderEvidence, verifyReaderEvidence, type ComparisonAttestation, type FrozenCrmEntry, type ReaderEvidenceManifest,
  type ReaderEvidenceQualification, type SemanticCallRecord,
} from "./comparison-evidence";

/** Separate comparison campaign of the current and the single-call reader on a frozen list of
 * stored dossiers. It never runs on the live mail path: an administrator launches small batches.
 * Read-only CRM, no executor, no live ledger, attempts, runs or call policy. Its own caps and its
 * own append-only ledger (audit events). OFF unless SAV_INTAKE_COMPARISON_JSON is configured. */
export const SAV_INTAKE_COMPARISON_REVISION = "sav-intake-comparison-2026-10-31.v5";
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
const scope = (campaignId: string) => and(eq(auditLogs.action, ACTION), eq(auditLogs.entityType, ENTITY), sql`${auditLogs.technicalMetadata}->>'campaignId' = ${campaignId}`);
/** SQL projection of named scalar fields only: results and receipts are excluded at the SELECT, so a
 * claim, a reservation or a plan check never loads a stored result (60 receipts would be hundreds of MiB). */
const projection = (fields: readonly string[]) => sql.join(fields.map(field => {
  // Constant field names only, inlined as literals so the jsonb operator is never ambiguous.
  if (!/^[A-Za-z0-9]+$/.test(field)) throw Error("SAV_INTAKE_COMPARISON_PROJECTION_INVALID");
  return sql`${sql.raw(`'${field}'`)}, ${auditLogs.technicalMetadata}->${sql.raw(`'${field}'`)}`;
}), sql`, `);
const LEDGER_FIELDS = ["campaignId", "messageId", "claimId", "callId", "event", "state", "reservedNanoUsd", "chargedNanoUsd"] as const;
// The list adds the verdict, the small encrypted result and the attestation facts; never `evidence`.
const LIST_FIELDS = [...LEDGER_FIELDS, "verdict", "payload", "receiptSha256", "oracleSha256", "outcome", "at"] as const;
const select = (fields: readonly string[]) => async (db: Reader, campaignId: string) => (await db.select({
  metadata: sql<Meta>`jsonb_strip_nulls(jsonb_build_object(${projection(fields)}))` }).from(auditLogs).where(scope(campaignId))).map(r => r.metadata as Meta);
const events = select(LEDGER_FIELDS), listed = select(LIST_FIELDS);
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
    const unbilled = !valid && isUnbilledProviderStatus(unbilledProviderStatus);
    await append(requireDb(), { campaignId, callId, event: "settled", state: valid || unbilled ? "settled" : "uncertain", chargedNanoUsd: valid ? Number(i) * 750 + (Number(o) + Number(t)) * 3750 : 0 });
    return valid || unbilled;
  };
}

/** One frozen CRM view shared by both readers: captured once, then served only from the capture.
 * Anything a reader needs that was not captured is a recorded coverage miss, never a fresh read.
 * After the freeze each read gets its own copy of the captured answer, so a reader can never
 * alter what the other one, or the receipt, sees. */
export function frozenComparisonCrm(live: SavIntakeCrmReaders) {
  const captured = new Map<string, Promise<unknown>>(), misses = new Set<string>(), served = new Set<string>();
  let snapshot: Map<string, FrozenCrmEntry> | null = null;
  const wrap = <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>, frozen: () => boolean) => async (...args: A): Promise<R> => {
    const key = `${name}:${String(args[0])}`;
    if (frozen()) served.add(key);
    const entry = frozen() ? snapshot?.get(key) : undefined;
    if (entry?.outcome === "resolved") return structuredClone({ status: entry.status, data: entry.data, observedAt: entry.observedAt,
      ...(entry.reconstructedAsOf !== undefined ? { reconstructedAsOf: entry.reconstructedAsOf } : {}) }) as R;
    if (captured.has(key)) return captured.get(key) as Promise<R>;
    if (frozen()) { misses.add(key); return { status: "failed", data: null, observedAt: new Date().toISOString() } as R; }
    const value = fn(...args); captured.set(key, value); return value;
  };
  let isFrozen = false;
  const build = (frozen: () => boolean): SavIntakeCrmReaders => ({ findContactsByEmail: wrap("contacts", live.findContactsByEmail, frozen),
    directAssociations: wrap("associations", live.directAssociations, frozen), getContact: wrap("contact", live.getContact, frozen),
    ticketsForContact: wrap("tickets", live.ticketsForContact, frozen), ticketHistory: wrap("history", live.ticketHistory, frozen) });
  return { capture: build(() => false), frozen: build(() => isFrozen),
    /** Same hash as before this receipt existed (recipe in comparison-evidence), plus the exact entries. */
    freeze: async () => {
      isFrozen = true;
      const entries = await Promise.all([...captured].sort(([a], [b]) => a.localeCompare(b)).map(async ([key, value]): Promise<FrozenCrmEntry> => {
        try {
          const read = structuredClone(await value) as ReadResult<unknown> | null;
          // A resolved non-object behaves like an error under the hash recipe; keep it explicit.
          if (!read || typeof read !== "object") return { key, outcome: "rejected" };
          return { key, outcome: "resolved", status: read.status, data: read.data ?? null, observedAt: read.observedAt,
            ...(read.reconstructedAsOf !== undefined ? { reconstructedAsOf: read.reconstructedAsOf } : {}) };
        } catch { return { key, outcome: "rejected" }; }
      }));
      snapshot = new Map(entries.map(entry => [entry.key, entry]));
      return { hash: savFrozenCrmHash(entries), entries: structuredClone(entries) };
    },
    /** Recomputed after both readers: proves the served capture was not altered. */
    unchanged: (hash: string) => snapshot !== null && savFrozenCrmHash([...snapshot.values()]) === hash,
    misses, served: () => [...served].sort(),
    /** Captured reads a reader actually used that were not complete: a missing record is not a real
     * absence. A complete answer with zero record (customer unknown) stays comparable. */
    failedUsed: async () => {
      const out: string[] = [];
      for (const key of served) {
        const entry = snapshot?.get(key);
        if (captured.has(key) && !(entry?.outcome === "resolved" && entry.status === "complete")) out.push(`crm_${entry?.outcome === "resolved" ? entry.status ?? "error" : "error"}:${key.split(":")[0]}`);
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

/** What each semantic answer the engine consumed was asked and returned (after the reader's own
 * reduction), in order. References only for inputs: their content is in the common block. */
function recordSemantic(semantic: SavIntakeSemanticReaders, calls: SemanticCallRecord[]): SavIntakeSemanticReaders {
  type Method = SemanticCallRecord["method"];
  const record = <I, O>(method: Method, refs: (input: I) => Record<string, unknown>, fn: (input: I, signal: AbortSignal) => Promise<O>) => async (input: I, signal: AbortSignal): Promise<O> => {
    const call: SemanticCallRecord = { order: calls.length, method, input: refs(input), status: "started" }; calls.push(call);
    try { const output = await fn(input, signal); call.status = "returned";
      // No derived image text in a receipt (this runner loads no attachment; kept explicit).
      const { attachmentObservations, ...kept } = (output && typeof output === "object" ? output : {}) as Record<string, unknown>; void attachmentObservations;
      call.output = structuredClone(output && typeof output === "object" ? kept : output); return output; }
    catch (error) { call.status = "failed"; call.errorCode = error instanceof Error && /^SAV_[A-Z0-9_]+$/.test(error.message) ? error.message : "SAV_INTAKE_COMPARISON_FAILED"; throw error; }
  };
  type Issues = Parameters<IntakeAdapters["assessIssues"]>[0];
  type Identity = Parameters<NonNullable<IntakeAdapters["assessIdentity"]>>[0];
  return { analyseMessage: record("analyseMessage", (i: Parameters<IntakeAdapters["analyseMessage"]>[0]) => ({ messageId: i.message.id, conversationIds: i.conversation.map(m => m.id),
      identificationContinuation: i.identificationContinuation ?? null }), semantic.analyseMessage),
    assessIssues: record("assessIssues", (i: Issues) => ({ messageId: i.message.id, requestIds: i.requests.map(r => r.id), ticketIds: i.tickets.map(t => t.ticket.id),
      evidenceIds: i.evidence.map(e => e.id), requestContextMessageId: i.requestContext?.id ?? null }), semantic.assessIssues),
    ...(semantic.assessIdentity ? { assessIdentity: record("assessIdentity", (i: Identity) => ({ messageId: i.message.id, address: i.address,
      candidateContactIds: i.candidates.map(c => c.contact.id), ticketIds: i.candidates.flatMap(c => c.tickets.map(t => t.ticket.id)),
      evidenceIds: i.evidence.map(e => e.id), requestContextMessageId: i.requestContext?.id ?? null }), semantic.assessIdentity) } : {}) };
}
type Evidence = ReturnType<typeof assembleReaderEvidence> | ReturnType<typeof unavailableReaderEvidence> | ReturnType<typeof commonOversizeReaderEvidence>;
type Compared = ReturnType<typeof compareIntakeSides> & { coverage: string[]; snapshotHash: string | null; current: Side | null; simple: Side | null; evidence: Evidence };

async function compareOne(messageId: string, claimId: string, campaign: SavIntakeComparisonConfig, runtime: IntakeRuntimeConfig,
  env: () => Record<string, string | undefined>, network: typeof fetch, clock: () => number): Promise<Compared> {
  const binding = { campaignId: campaign.campaignId, messageId, claimId }, started = clock();
  const [message] = await requireDb().select().from(savMessages).where(eq(savMessages.id, messageId));
  if (!message) return { coverage: ["message_missing"], snapshotHash: null, current: null, simple: null, ...compareIntakeSides(empty, empty, ["message_missing"]), evidence: unavailableReaderEvidence(binding, ["message_missing"]) };
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
    return { coverage: cause, snapshotHash: null, current: null, simple: null, ...compareIntakeSides(empty, empty, cause), evidence: unavailableReaderEvidence(binding, cause) };
  }
  if (catalogue && qualifyRuntimeCandidate({ mailboxId: message.mailboxId, subject: message.subject, body: { text: snapshot.body.text ?? "" } }, catalogue)) coverage.push("qualified_other_candidate");
  const policy: EnginePolicy = runtime.policy;
  // SAV-46 R2: every address the engine could accept as a declared registration is captured with
  // the sender's scope before any paid call. Capture is not identity: the engine still proves the
  // account role. More than the cap is refused before dispatch, never truncated.
  const declared = savIntakeDeclaredAddressCandidates(snapshot.input);
  if (declared.length > SAV_INTAKE_DECLARED_ADDRESS_CAP) {
    const refused = [...new Set([...coverage, "declared_address_cap_exceeded"])];
    return { coverage: refused, snapshotHash: null, current: null, simple: null, ...compareIntakeSides(empty, empty, refused), evidence: unavailableReaderEvidence(binding, refused) };
  }
  const crm = frozenComparisonCrm(createSavIntakeHubspotReaders({ network: async (url, init) => network(url, { ...init, redirect: "error",
    headers: { ...Object.fromEntries(new Headers(init?.headers)), Authorization: `Bearer ${env().HUBSPOT_ACCESS_TOKEN}` } }) }));
  // Capture the superset both readers use (sender and admissible declared contacts, admitted links,
  // tickets, histories), then freeze. Both sender spellings: the simple reader reads the raw sender,
  // the engine its normalized form; a declared address is looked up normalized, in sorted order.
  for (const address of new Set([snapshot.input.message.fromEmail, snapshot.input.message.fromEmail.trim().toLowerCase(), ...declared]))
    await readIntakeSimpleContext(crm.capture, address, policy, AbortSignal.timeout(30_000));
  const frozen = await crm.freeze(), crmHash = frozen.hash;
  const commonPreparationMs = Math.max(0, clock() - started);
  const inventory = (snapshot.body as { attachmentInventory?: unknown }).attachmentInventory;
  const common = comparisonCommonEvidence({ sourceHash: snapshot.sourceHash, messageSourceHash: snapshot.messageSourceHash, engineInput: snapshot.input, provenance: snapshot.provenance,
    attachments: { count: snapshot.body.attachments?.length ?? 0, inventoryComplete: inventory === undefined ? null : savAttachmentInventorySchema.safeParse(inventory).data?.complete ?? false },
    crm: frozen });
  // The receipt must be storable before anything is paid for: an oversize common capture makes no call.
  if (savBoundedJsonBytes(common, SAV_READER_EVIDENCE_LIMITS.commonBytes) === null) {
    const refused = [...new Set([...coverage, "evidence_common_oversize"])];
    return { coverage: refused, snapshotHash: savComparisonSnapshotHash(snapshot.sourceHash, crmHash), current: null, simple: null, ...compareIntakeSides(empty, empty, refused),
      evidence: commonOversizeReaderEvidence(binding, commonPreparationMs) };
  }
  // SAV-72: a created ticket's description is the stored original email, never the planner's text.
  const fromOriginalMail = (plannerDescription: string) => intakeTicketDescription({ subject: message.subject, text: String(snapshot.body.text ?? ""),
    unreadAttachmentNotice: intakeUnreadAttachmentNotice(plannerDescription) });
  const side = async (kind: "current" | "simple") => {
    const traces: IntakeModelTrace[] = [], validated: IntakeValidatedEvidence[] = [], semanticCalls: SemanticCallRecord[] = [];
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(Error("SAV_INTAKE_COMPARISON_DEADLINE")), SAV_AI_BUDGET.durationMs);
    const dispatcher = createIntakeModelDispatcher({ config: runtime, signal: controller.signal, env, network,
      captureDiagnostics: true, ...(kind === "simple" ? { generationBudget: "single_pass" as const } : {}),
      live: async () => { if (controller.signal.aborted) throw Error("SAV_INTAKE_COMPARISON_DEADLINE"); if (!savIntakeComparisonConfig(env())) throw Error("SAV_INTAKE_COMPARISON_EXPIRED"); },
      reserve: hash => reserveSavIntakeComparisonCall(env, campaign.campaignId, messageId, claimId, hash, runtime.model, controller.signal), settle: settleSavIntakeComparisonCall(campaign.campaignId),
      preflight: hashes => assertSavIntakeComparisonPlan(env, campaign.campaignId, messageId, hashes, runtime.model, controller.signal) });
    const onValidatedEvidence = (evidence: IntakeValidatedEvidence) => { validated.push(evidence); };
    const semantic = kind === "simple"
      ? createSavIntakeSimpleReaders({ model: runtime.model, call: dispatcher.call, crm: crm.frozen, policy, provenance: snapshot.provenance, onTrace: t => traces.push(t), onValidatedEvidence })
      : createSavIntakeSemanticReaders({ model: runtime.model, call: dispatcher.call, planCalls: dispatcher.plan, provenance: snapshot.provenance, onTrace: t => traces.push(t), onValidatedEvidence });
    let plan: IntakePlan | undefined, technical: string | null = null;
    // Each side's own wall time: it starts here, after the common preparation and the previous side.
    const startedAt = new Date().toISOString(), sideStarted = clock();
    try { plan = await withSavAiBudget(() => planSavIntake(structuredClone(snapshot.input), { ...crm.frozen, ...recordSemantic(semantic, semanticCalls) }, policy, { timeoutMs: 10_000, modelTimeoutMs: SAV_AI_BUDGET.durationMs }, () => new Date())); }
    catch (error) { technical = error instanceof Error && /^SAV_[A-Z0-9_]+$/.test(error.message) ? error.message : "SAV_INTAKE_COMPARISON_FAILED"; }
    finally { try { await Promise.allSettled(dispatcher.pending); } finally { clearTimeout(timer); } }
    const wallMs = Math.max(0, clock() - sideStarted);
    technical ??= savAiCancellationCode(controller.signal);
    technical ??= dispatcher.failureReason ?? traces.find(t => !t.accepted && t.errorCode)?.errorCode ?? null;
    const { dispatches, httpResponses } = intakeDispatchCounts(dispatcher.diagnostics);
    const result: Side = { summary: technical ? null : intakePlanSummary(plan), technical, uncertain: dispatcher.uncertain, calls: dispatches,
      diagnostics: { requests: dispatcher.diagnostics, failures: comparisonValidationDiagnostics(traces),
        dispatches,
        httpResponses } };
    const evidence = comparisonSideEvidence({ side: kind, readerRevision: kind === "simple" ? SAV_INTAKE_SIMPLE_REVISION : SAV_INTAKE_MODEL_REVISION, plan: plan ?? null,
      technical, uncertain: dispatcher.uncertain, semanticCalls, validated, timing: comparisonSideTiming({ startedAt, wallMs, requests: dispatcher.diagnostics }),
      expectations: plan ? intakeMutationExpectations(plan, frozen.entries, fromOriginalMail) : null });
    return { result, evidence };
  };
  const current = await side("current"), simple = await side("simple");
  const failedUsed = await crm.failedUsed(), immutable = crm.unchanged(crmHash);
  coverage.push(...[...crm.misses].map(key => `crm_not_captured:${key.split(":")[0]}`), ...failedUsed, ...(immutable ? [] : ["crm_snapshot_mutated"]));
  const snapshotHash = savComparisonSnapshotHash(snapshot.sourceHash, crmHash);
  const identity = { ...binding, comparisonRevision: SAV_INTAKE_COMPARISON_REVISION, codeRevision: runtime.codeRevision,
    readerRevisions: { current: SAV_INTAKE_MODEL_REVISION, simple: SAV_INTAKE_SIMPLE_REVISION }, engineRevision: "sav-intake-engine-2026-10-20.v1" satisfies IntakePlan["revision"],
    model: runtime.model, runtimeConfigHash: runtime.configHash, enginePolicyHash: runtime.policyHash, resourcesHash: runtime.resourcesHash,
    otherCatalogue: catalogue ? { ...catalogue.resource, expiresAt: catalogue.expiresAt } : null };
  const evidence = assembleReaderEvidence({ identity, common, sides: { current: current.evidence, simple: simple.evidence },
    crmUse: { served: crm.served(), misses: [...crm.misses].sort(), failedUsed, immutable }, snapshotHash, commonPreparationMs, clock });
  return { coverage: [...new Set(coverage)], snapshotHash, current: current.result, simple: simple.result, ...compareIntakeSides(current.result, simple.result, [...new Set(coverage)]), evidence };
}
const empty: Side = { summary: null, technical: null, uncertain: false, calls: 0 };

/** One bounded batch: the next unclaimed dossiers of the frozen list, one at a time. A claim
 * without a result (worker interrupted) is reported as interrupted and never re-sent automatically. */
export async function runSavIntakeComparisonBatch(options: { env?: () => Record<string, string | undefined>; network?: typeof fetch; limit?: number; clock?: () => number } = {}) {
  const env = options.env ?? (() => process.env), network = options.network ?? fetch, limit = Math.min(5, Math.max(1, options.limit ?? 3));
  const clock = options.clock ?? (() => performance.now());
  const campaign = savIntakeComparisonConfig(env()), runtime = savIntakeRuntimeConfig(env());
  if (!campaign || !runtime) return { skipped: "off" as const };
  const done: { messageId: string; verdict: string; qualificationEvidence: string; persistMs: number }[] = [];
  for (const messageId of campaign.messageIds) {
    if (done.length >= limit) break;
    const claimId = await claimSavIntakeComparison(campaign.campaignId, messageId);
    if (!claimId) continue;
    let result: Compared;
    try { result = await compareOne(messageId, claimId, campaign, runtime, env, network, clock); }
    catch (error) {
      const code = error instanceof Error && /^SAV_[A-Z0-9_]+$/.test(error.message) ? error.message : "SAV_INTAKE_COMPARISON_FAILED";
      result = { verdict: "incomplete", differences: [code], coverage: [], snapshotHash: null, current: null, simple: null, evidence: unavailableReaderEvidence({ campaignId: campaign.campaignId, messageId, claimId }, [code]) };
    }
    const { evidence, ...compared } = result;
    let manifest: ReaderEvidenceManifest = evidence.manifest, sealed: string | null = null;
    if (evidence.receipt) {
      const encrypting = clock(), ciphertext = encryptSavPayload(evidence.receipt);
      const bounded = boundReaderEvidenceCiphertext(manifest, Buffer.byteLength(ciphertext, "utf8"), Math.max(0, clock() - encrypting));
      manifest = bounded.manifest; if (bounded.keep) sealed = ciphertext;
    }
    // One atomic row: the result, its code-only manifest and its receipt are stored together or not at all.
    const persisting = clock();
    try {
      await append(requireDb(), { campaignId: campaign.campaignId, messageId, claimId, event: "result", verdict: compared.verdict,
        payload: encryptSavPayload({ revision: SAV_INTAKE_COMPARISON_REVISION, at: new Date().toISOString(), ...compared, evidence: manifest }), ...(sealed ? { evidence: sealed } : {}) });
    } catch {
      // Codes and sizes only. The claim stays consumed: reported interrupted, never paid for again.
      console.warn("sav_intake_comparison", { error: "SAV_INTAKE_COMPARISON_PERSIST_FAILED", evidence: manifest.status, totalBytes: manifest.bytes.total, ciphertextBytes: manifest.bytes.ciphertext });
      throw Error("SAV_INTAKE_COMPARISON_PERSIST_FAILED");
    }
    done.push({ messageId, verdict: compared.verdict, qualificationEvidence: manifest.status, persistMs: Math.max(0, clock() - persisting) });
  }
  return { campaignId: campaign.campaignId, compared: done };
}

const campaignOf = (env: () => Record<string, string | undefined>) => savIntakeComparisonConfig(env())
  ?? (() => { try { return campaignSchema.parse(JSON.parse(env().SAV_INTAKE_COMPARISON_JSON ?? "")); } catch { return null; } })();
type Attestation = Omit<ComparisonAttestation, "campaignId" | "messageId">;
/** One dossier's ledger facts, computed identically for the list and the detail. */
function dossierRow(campaignId: string, messageId: string, all: readonly Meta[]) {
  const claim = all.find(e => e.event === "claimed" && e.messageId === messageId), results = all.filter(e => e.event === "result" && e.messageId === messageId), result = results[0];
  const claimId = typeof claim?.claimId === "string" ? claim.claimId : null;
  let detail: Record<string, unknown> | null = null;
  if (result && typeof result.payload === "string") { try { detail = decryptSavPayload<Record<string, unknown>>(result.payload); } catch { detail = null; } }
  // Two results, a result of another claim or an unreadable payload can never qualify.
  const qualificationEvidence: ReaderEvidenceQualification | null = !result ? null : results.length !== 1 || !claimId || result.claimId !== claimId ? "invalid"
    : readerEvidenceQualification(detail, { campaignId, messageId, claimId });
  const attested = all.filter(e => e.event === "attested" && e.messageId === messageId);
  const attestation: Attestation | "invalid" | null = !attested.length ? null : attested.length > 1 ? "invalid"
    : { claimId: String(attested[0].claimId), receiptSha256: String(attested[0].receiptSha256), oracleSha256: String(attested[0].oracleSha256),
      outcome: attested[0].outcome === "matches_oracle" ? "matches_oracle" : "differs_from_oracle", at: String(attested[0].at) };
  return { messageId, claimId, state: result ? "done" : claim ? "interrupted" : "pending", verdict: (result?.verdict as string | undefined) ?? null, detail, qualificationEvidence, attestation };
}

/** Administrator report of one campaign: every listed dossier with its state, verdicts with
 * denominators, technical outcome per side, evidence manifest and attestation, spend. It never loads a
 * receipt: the one-dossier detail does. Contains generated ticket titles (admin only). */
export async function readSavIntakeComparisonReport(env: () => Record<string, string | undefined> = () => process.env) {
  const campaign = campaignOf(env);
  if (!campaign) return { configured: false as const };
  const all = await listed(requireDb(), campaign.campaignId);
  const rows = campaign.messageIds.map(messageId => dossierRow(campaign.campaignId, messageId, all));
  const count = (verdict: string) => rows.filter(r => r.verdict === verdict).length;
  const evidence = (status: ReaderEvidenceQualification) => rows.filter(r => r.qualificationEvidence === status).length;
  return { configured: true as const, revision: SAV_INTAKE_COMPARISON_REVISION, campaignId: campaign.campaignId, until: campaign.until,
    denominators: { listed: rows.length, done: rows.filter(r => r.state === "done").length, interrupted: rows.filter(r => r.state === "interrupted").length, pending: rows.filter(r => r.state === "pending").length },
    // Verdicts compare two projections; they are not business correctness.
    verdicts: { identical: count("identical"), divergent: count("divergent"), incomplete: count("incomplete"), non_comparable: count("non_comparable") },
    qualificationEvidence: { complete: evidence("complete"), incomplete: evidence("incomplete"), oversize: evidence("oversize"), not_available: evidence("not_available"), legacy: evidence("legacy"), invalid: evidence("invalid"),
      attested: rows.filter(r => r.attestation && r.attestation !== "invalid").length },
    spend: { nanoUsd: savIntakeComparisonSpend(all), maxNanoUsd: campaign.maxNanoUsd }, rows };
}

/** The private receipt of ONE listed dossier, decrypted and verified. The caller authenticates the
 * administrator first; an identifier outside the campaign list is refused before any lookup. */
export async function readSavIntakeComparisonEvidence(messageId: string, env: () => Record<string, string | undefined> = () => process.env) {
  const campaign = campaignOf(env);
  if (!campaign) throw Error("SAV_INTAKE_COMPARISON_CONFIGURATION_REQUIRED");
  if (!campaign.messageIds.includes(messageId)) throw Error("SAV_INTAKE_COMPARISON_SCOPE_INVALID");
  const found = await requireDb().select({ metadata: sql<Meta>`jsonb_strip_nulls(jsonb_build_object(${projection(LIST_FIELDS)}))`, evidence: sql<string | null>`${auditLogs.technicalMetadata}->>'evidence'` })
    .from(auditLogs).where(and(scope(campaign.campaignId), sql`${auditLogs.technicalMetadata}->>'messageId' = ${messageId}`));
  const row = dossierRow(campaign.campaignId, messageId, found.map(r => r.metadata as Meta));
  const sealed = found.filter(r => r.metadata.event === "result").map(r => r.evidence);
  const base = { campaignId: campaign.campaignId, ...row, receipt: null as unknown, verification: null as { ok: boolean; reason: string | null } | null };
  if (row.qualificationEvidence === null || row.qualificationEvidence === "legacy" || row.qualificationEvidence === "invalid" || !row.claimId) return base;
  const manifest = readerEvidenceManifestSchema.parse(row.detail!.evidence);
  if (!manifest.stored) return base;
  const fail = (reason: string) => ({ ...base, qualificationEvidence: "invalid" as const, verification: { ok: false, reason } });
  if (sealed.length !== 1 || typeof sealed[0] !== "string") return fail("receipt_missing");
  if (Buffer.byteLength(sealed[0], "utf8") > SAV_READER_EVIDENCE_LIMITS.ciphertextBytes || Buffer.byteLength(sealed[0], "utf8") !== manifest.bytes.ciphertext) return fail("receipt_ciphertext_size_mismatch");
  let receipt: unknown;
  try { receipt = decryptSavPayload<unknown>(sealed[0]); } catch { return fail("receipt_ciphertext_invalid"); }
  const verification = verifyReaderEvidence(receipt, manifest, { campaignId: campaign.campaignId, messageId, claimId: row.claimId },
    typeof row.detail!.snapshotHash === "string" ? row.detail!.snapshotHash : null);
  return verification.ok ? { ...base, receipt, verification } : fail(verification.reason);
}

/** Append-only human attestation, at most one per dossier, bound to the claim and the exact receipt. */
export async function appendSavIntakeComparisonAttestation(attestation: ComparisonAttestation, actorEmail: string) {
  return requireDb().transaction(async tx => {
    await tx.execute(LOCK);
    const all = await events(tx, attestation.campaignId);
    if (all.some(e => e.event === "attested" && e.messageId === attestation.messageId)) throw Error("SAV_INTAKE_COMPARISON_ALREADY_ATTESTED");
    if (!all.some(e => e.event === "claimed" && e.messageId === attestation.messageId && e.claimId === attestation.claimId)) throw Error("SAV_INTAKE_COMPARISON_STALE_COMMAND");
    await tx.insert(auditLogs).values({ actorEmail, action: ACTION, entityType: ENTITY, entityId: attestation.claimId, technicalMetadata: { ...attestation, event: "attested" } });
  });
}
