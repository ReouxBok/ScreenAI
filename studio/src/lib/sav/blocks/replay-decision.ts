import type { SavRetrievalCandidate } from "../request-retrieval";
import { prepareCaseReplyText, type CaseReplyAiMode } from "../cases/case-reply-outbound";
import {
  emptyCaseBody, SAV_CASE_ADMISSION_REVISION, SAV_CASE_CONTRACT_REVISION, SAV_CASE_REQUEST_FAMILIES,
  type CaseAdmissionQualification, type CaseEvent, type CaseRequestFamily, type CaseSnapshot,
} from "../cases/case-types";
import { caseDecisionRejectionLabels, SAV_CASE_ACCESS_URL, type CaseDecisionRejection, type CaseDecisionValidation } from "../cases/decision-contract";
import { buildCaseCustomerAttachments, withCaseCustomerAttachments } from "../cases/investigation-customer-attachments";
import { buildCaseCustomerContext, maskCaseCustomerText, type CaseCustomerContext } from "../cases/investigation-customer-context";
import {
  runCaseInvestigation, type CaseInvestigationAttempt, type CaseInvestigationModelRequest, type CaseInvestigationModelResult, type CaseInvestigationPorts,
  type CaseInvestigationProgress, type CaseInvestigationRecord, type CaseInvestigationReport,
} from "../cases/investigation-runner";
import type { SavBlockMode } from "./block-attribution";
import type { SavReplayDecisionInput, SavReplayDecisionOutput } from "./block-replay";

/*
 * SAV-92 harness, phase 1b: the REAL V2 decision path for one replayed mail, with NO EFFECT.
 *
 * The case is replayed through the production runner itself (`runCaseInvestigation`: gate, admission, customer context, decision
 * context, the model request, the decision validator with its corrections, the second refusal handing to the team), on IN-MEMORY
 * ports: the case is read from memory (a synthetic case built from the mail, or a stored case read beforehand), the lease, the progress
 * and the record are kept in this run's memory only, the ticket owner answers `v2`, the pause answers `running`. The prompt is the
 * production one (`caseInvestigationPrompt`, through the live transport); nothing here composes a prompt.
 *
 * Zero effect, by construction: the runner has no effect port (no email, HubSpot, Slack, effect registry); the only write ports it has
 * (lease, progress, record, re-evaluation) are replaced here by memory or a throw. The model is reached only through an injected transport:
 * a deterministic stub by default, the live Gemini transport only when the caller builds it explicitly (`replay-decision-live.ts`).
 * Money: a dedicated in-memory meter, a per-run cap (2 USD by default, 10 USD at most) and a per-mail cap. Each call reserves its worst case
 * before it is sent; a reservation that does not fit is refused and the call is never sent (the runner reads it as a deferral, nothing spent).
 * An uncertain call keeps its reservation. The production spend register and call ledger are never touched.
 */

export const SAV_REPLAY_SPEND_LIMITS = Object.freeze({ defaultRunUsd: 2, maxRunUsd: 10, defaultMailUsd: 0.5 });
/** The policy revision the synthetic admission is decided under (never a production policy). */
export const SAV_REPLAY_POLICY_REVISION = "sav-replay-policy.v1";
export const SAV_REPLAY_STUB_MODEL = "sav-replay-stub.v1";

// ---------------------------------------------------------------------------------------------------------------------------------
// Spend meter (in memory, micro-dollars)
// ---------------------------------------------------------------------------------------------------------------------------------

export type SavReplaySpendTotals = Readonly<{ runCapUsd: number; mailCapUsd: number; calls: number; refused: number; reservedUsd: number; actualUsd: number; committedUsd: number }>;
export type SavReplaySpendMeter = {
  readonly runCapUsd: number; readonly mailCapUsd: number;
  /** Reserves the worst case of one call for this mail, or refuses it (nothing may then be sent). */
  reserve(mailRef: string, amountUsd: number): { ok: true; id: number } | { ok: false; reason: "run_cap" | "mail_cap" };
  /** Settles a reservation: the actual cost, or null to keep the reserved amount (unknown or uncertain usage, never free). */
  settle(id: number, actualUsd: number | null): void;
  /** Whether one more call of this worst case still fits the run cap. */
  fits(amountUsd: number): boolean;
  mailCommittedUsd(mailRef: string): number;
  totals(): SavReplaySpendTotals;
};

const micro = (usd: number) => Math.ceil(Math.max(0, usd) * 1_000_000 - 1e-6);
const usdOf = (value: number) => value / 1_000_000;

export function createSavReplaySpendMeter(options: Readonly<{ runCapUsd?: number; mailCapUsd?: number }> = {}): SavReplaySpendMeter {
  const runCapUsd = options.runCapUsd ?? SAV_REPLAY_SPEND_LIMITS.defaultRunUsd;
  if (!(Number.isFinite(runCapUsd) && runCapUsd > 0 && runCapUsd <= SAV_REPLAY_SPEND_LIMITS.maxRunUsd)) throw new Error("SAV_REPLAY_BUDGET_INVALID");
  const mailCapUsd = options.mailCapUsd ?? Math.min(SAV_REPLAY_SPEND_LIMITS.defaultMailUsd, runCapUsd);
  if (!(Number.isFinite(mailCapUsd) && mailCapUsd > 0 && mailCapUsd <= runCapUsd)) throw new Error("SAV_REPLAY_MAIL_BUDGET_INVALID");
  const runCap = micro(runCapUsd), mailCap = micro(mailCapUsd);
  const open = new Map<number, { mail: string; amount: number }>(), byMail = new Map<string, number>();
  let committed = 0, reserved = 0, actual = 0, calls = 0, refused = 0, next = 1;
  const add = (mail: string, amount: number) => { committed += amount; byMail.set(mail, (byMail.get(mail) ?? 0) + amount); };
  return {
    runCapUsd, mailCapUsd,
    reserve(mailRef, amountUsd) {
      const amount = micro(amountUsd);
      if (committed + amount > runCap) { refused++; return { ok: false, reason: "run_cap" }; }
      if ((byMail.get(mailRef) ?? 0) + amount > mailCap) { refused++; return { ok: false, reason: "mail_cap" }; }
      const id = next++;
      open.set(id, { mail: mailRef, amount }); add(mailRef, amount); reserved += amount; calls++;
      return { ok: true, id };
    },
    settle(id, actualUsd) {
      const held = open.get(id);
      if (!held) return;
      open.delete(id);
      if (actualUsd === null || !Number.isFinite(actualUsd) || actualUsd < 0) { actual += held.amount; return; }
      const spent = micro(actualUsd);
      // Settled at what was reported; a report above the reservation is kept as reported (counted, never hidden).
      add(held.mail, spent - held.amount); actual += spent;
    },
    fits: amountUsd => committed + micro(amountUsd) <= runCap,
    mailCommittedUsd: mailRef => usdOf(byMail.get(mailRef) ?? 0),
    totals: () => ({ runCapUsd, mailCapUsd, calls, refused, reservedUsd: usdOf(reserved), actualUsd: usdOf(actual), committedUsd: usdOf(committed) }),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Model transports
// ---------------------------------------------------------------------------------------------------------------------------------

export type SavReplayModelUsage = Readonly<{ inputTokens?: number; outputTokens?: number }>;
export type SavReplayModelTransport = Readonly<{
  kind: "stub" | "live"; model: string;
  /** Worst case of one call: what is reserved before it is sent. */
  reservePerCallUsd: number;
  /** Estimated cost of this exact request (its body measured, the maximum output). */
  estimateUsd(request: CaseInvestigationModelRequest): number;
  /** One call, sent at most once. `costUsd` null: unknown (the reservation is kept). */
  call(request: CaseInvestigationModelRequest): Promise<{ result: CaseInvestigationModelResult; usage: SavReplayModelUsage | null; costUsd: number | null }>;
}>;

/**
 * The deterministic stub decision: an answer from the first card's own steps (the access link added when an access request is open),
 * or one targeted question when no card was retrieved. Same request, same output. It exercises the whole path (validator included)
 * without a model; it says nothing about what the real model would write.
 */
export function savReplayStubProposal(request: CaseInvestigationModelRequest): unknown {
  const open = request.snapshot.body.openRequests.filter(row => row.status === "open");
  const understanding = { requests: open.map(row => ({ id: row.id, summary: row.summary.slice(0, 600), family: row.family, status: "open" as const })), newFacts: [] };
  const link = open.some(row => row.family === "access") ? `\n\nLien de connexion : ${SAV_CASE_ACCESS_URL}` : "";
  const card = request.knowledge[0];
  if (card && open.length) {
    const raw = Array.isArray(card.resolution?.steps) ? (card.resolution!.steps as unknown[]).filter((step): step is string => typeof step === "string" && step.trim().length > 0) : [];
    const steps = (raw.length ? raw : [card.title]).slice(0, 3).map(step => step.trim().slice(0, 1000));
    const ref = { knowledgeId: card.id, contentVersionId: card.contentVersionId };
    const text = `Bonjour,\n\nVoici la marche à suivre (${card.title.slice(0, 200)}) :\n${steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}${link}`;
    return { caseVersion: request.caseVersion, understanding,
      nextAction: { kind: "answer", requestIds: open.map(row => row.id), steps: steps.map(step => ({ text: step, knowledge: ref, newFactIds: [] })), expectedResult: "La demande décrite est résolue." },
      reply: { text, citations: [ref], impossibilityClaims: [], accountAdvice: "none" } };
  }
  const question = "Pouvez-vous nous décrire précisément ce qui s'affiche à l'écran au moment du blocage ?";
  return { caseVersion: request.caseVersion, understanding,
    nextAction: { kind: "ask", questions: [{ text: question, requestId: open[0]?.id ?? "r1", reducesUncertainty: "Savoir où la demande bloque.", seeks: [{ kind: "observed_result" }] }] },
    reply: { text: `Bonjour,\n\n${question}${link}`, citations: [], impossibilityClaims: [], accountAdvice: "none" } };
}

/** The default model: no network, no cost. `outputs`: a scripted sequence (tests), else the deterministic proposal above. */
export function createSavReplayStubModel(options: Readonly<{ outputs?: readonly unknown[] }> = {}): SavReplayModelTransport {
  const scripted = options.outputs ? [...options.outputs] : null;
  return {
    kind: "stub", model: SAV_REPLAY_STUB_MODEL, reservePerCallUsd: 0, estimateUsd: () => 0,
    async call(request) {
      if (scripted) {
        if (!scripted.length) return { result: { status: "failed", uncertain: false }, usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0 };
        return { result: { status: "ok", output: structuredClone(scripted.shift()) }, usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0 };
      }
      // The stub never proposes a closure, so it is never asked to check one.
      if (request.purpose !== "decision") return { result: { status: "failed", uncertain: false }, usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0 };
      return { result: { status: "ok", output: savReplayStubProposal(request) }, usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0 };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The replayed case
// ---------------------------------------------------------------------------------------------------------------------------------

export type SavReplayRequestInput = Readonly<{ text: string; family?: CaseRequestFamily; team?: boolean }>;
export type SavReplayAttachmentInput = Readonly<{ filename: string; mimeType: string; size: number; reading?: string | null; message?: "latest" | "previous" }>;
/** A case read beforehand from the store (read only), replayed as the agent would see it. */
export type SavReplayStoredCase = Readonly<{ snapshot: CaseSnapshot; events: readonly CaseEvent[]; customerTexts: Readonly<Record<string, string>>; customerContext?: CaseCustomerContext }>;
export type SavReplayCaseSource =
  | Readonly<{ kind: "synthetic"; ref: string; subject: string; text: string; messageId?: string; family: CaseRequestFamily; blockId: string;
      requests?: readonly SavReplayRequestInput[]; attachments?: readonly SavReplayAttachmentInput[] }>
  | Readonly<{ kind: "stored"; blockId: string; stored: SavReplayStoredCase }>;

/** The family of a block's requests: its id when it names a request family, else `usage` (the family of the non-Access blocks). */
export function savReplayBlockFamily(blockId: string, family?: CaseRequestFamily): CaseRequestFamily {
  if (family) return family;
  return (SAV_CASE_REQUEST_FAMILIES as readonly string[]).includes(blockId) ? blockId as CaseRequestFamily : "usage";
}

const REPLAY_RUN = "00000000-0000-4000-8000-000000000000";
const subjectOf = (text: string, at: string) => {
  const masked = maskCaseCustomerText(text).replace(/\s+/g, " ").trim().slice(0, 600);
  return masked.length >= 3 ? { status: "available" as const, text: masked,
    provenance: { source: "v1_accepted_analysis" as const, field: "requestQuote" as const, runId: REPLAY_RUN, runVersion: 1, resultHash: "sav-replay", validatorRevision: "sav-replay", acceptedAt: at } }
    : { status: "absent" as const, reason: "redacted_empty" as const };
};

type ReplayCase = { snapshot: CaseSnapshot; events: CaseEvent[]; customerTexts: Record<string, string>; customerContext?: CaseCustomerContext };

/** A synthetic case from one mail: one request per given part (the whole text by default), admitted for the agent under the replay policy. */
export function synthesizeSavReplayCase(source: Extract<SavReplayCaseSource, { kind: "synthetic" }>, now: Date): ReplayCase {
  const at = now.toISOString(), caseId = `replay:${source.ref}`.slice(0, 200), messageId = source.messageId ?? `replay-${source.ref}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 120);
  const parts = source.requests?.length ? source.requests : [{ text: source.text }];
  const openRequests = parts.map((part, index) => ({ id: `r${index + 1}`, summary: maskCaseCustomerText(part.text).replace(/\s+/g, " ").slice(0, 4000) || "Demande",
    family: part.family ?? source.family, status: part.team ? "handed_off" as const : "open" as const, openedAt: at, subject: subjectOf(part.text, at) }));
  const qualification: CaseAdmissionQualification = { identity: { status: "unknown" }, crmContext: "unknown", teamSignals: [],
    requests: openRequests.map((row, index) => ({ requestId: row.id, family: row.family,
      provenance: parts[index]!.team ? { kind: "team_part" as const, reason: "no_block_match" as const, at } : { kind: "qualified_rule" as const, ruleId: "sav-replay", revision: "sav-replay", at, blockId: source.blockId } })) };
  const snapshot: CaseSnapshot = { contractRevision: SAV_CASE_CONTRACT_REVISION, caseId, ticketId: "replay-ticket", threadIds: ["replay-thread"], version: 2,
    owner: "agent", phase: "queued", sensitivity: "none", createdAt: at, updatedAt: at, body: { ...emptyCaseBody(), openRequests }, admissionInputVersion: 1,
    admission: { revision: SAV_CASE_ADMISSION_REVISION, target: "agent", reasons: [], nextStep: "none", families: [...new Set(openRequests.map(row => row.family))], sensitivity: "none",
      policyRevision: SAV_REPLAY_POLICY_REVISION, decidedAt: at, version: 2, inputVersion: 1, qualification } };
  const events: CaseEvent[] = [{ id: "replay-e1", caseId, kind: "inbound_confirmed", dedupeKey: `inbound:${messageId}`, caseVersion: 1, direction: "customer_inbound",
    occurredAt: at, sourceRef: { type: "email", id: messageId }, detail: null, createdAt: at }];
  let customerContext = buildCaseCustomerContext({ latestMessageId: "replay-m1", messages: [{ id: "replay-m1", direction: "inbound", at, subject: source.subject, text: source.text }],
    crm: { status: "missing", reason: "crm_not_recorded" } });
  if (source.attachments?.length) {
    // The files are listed as V1 stored them (name, type, size, V1's reading); their bytes are never read in a replay (`media_off`).
    customerContext = withCaseCustomerAttachments(customerContext, buildCaseCustomerAttachments(source.attachments.map(file => ({ message: file.message ?? "latest",
      filename: file.filename, mimeType: file.mimeType, size: file.size, reading: file.reading ? { status: "analyzed" as const, text: file.reading, uncertainties: [] } : null,
      media: { ok: false as const, reason: "media_off" as const } }))));
  }
  return { snapshot, events, customerTexts: { [`email:${messageId}`]: source.text }, customerContext };
}

/**
 * A stored case as the agent would take it: its requests, facts, questions, trials, sensitivity and journal unchanged; only the owner and the
 * admission are those of an agent admitted under the replay policy (the requests the entry gave the team stay the team's).
 */
export function adaptSavReplayStoredCase(source: Extract<SavReplayCaseSource, { kind: "stored" }>, now: Date): ReplayCase {
  const { snapshot, events } = source.stored, at = now.toISOString();
  const stored = snapshot.admission?.qualification;
  const teamParts = new Set((stored?.requests ?? []).filter(row => row.provenance.kind === "team_part").map(row => row.requestId));
  const qualification: CaseAdmissionQualification = { identity: stored?.identity ?? { status: "unknown" }, crmContext: stored?.crmContext ?? "unknown", teamSignals: stored?.teamSignals ?? [],
    requests: snapshot.body.openRequests.map(row => ({ requestId: row.id, family: row.family, provenance: teamParts.has(row.id)
      ? (stored!.requests.find(item => item.requestId === row.id)!.provenance) : { kind: "qualified_rule" as const, ruleId: "sav-replay", revision: "sav-replay", at, blockId: source.blockId } })) };
  return { events: [...events], customerTexts: { ...source.stored.customerTexts }, ...(source.stored.customerContext ? { customerContext: source.stored.customerContext } : {}),
    snapshot: { ...snapshot, owner: "agent", admission: { revision: SAV_CASE_ADMISSION_REVISION, target: "agent", reasons: [], nextStep: "none",
      families: [...new Set(snapshot.body.openRequests.map(row => row.family))], sensitivity: snapshot.sensitivity, policyRevision: SAV_REPLAY_POLICY_REVISION, decidedAt: at,
      version: snapshot.version, inputVersion: snapshot.admissionInputVersion, qualification } } };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------------------------------------

export type SavReplayDecisionAction = "answer" | "ask" | "confirm_resolution" | "handoff" | "observe_only" | "team" | "none";
export type SavReplayDecisionDetail = Readonly<{
  /** The runner's own status (`recorded`, `skipped`, `deferred_budget`, `technical_wait`...). */
  runner: CaseInvestigationReport["status"];
  outcome: CaseDecisionValidation["outcome"] | null;
  action: SavReplayDecisionAction;
  /** Why the case would go to the team: the decision's handoff reason, the second refusal, or the gate. */
  team: Readonly<{ reason: string; codes?: readonly string[] }> | null;
  ask: Readonly<{ requestId: string; text: string }> | null;
  /** The exact text the customer would receive (help line, signature and AI mention included), or why there is none. */
  reply: Readonly<{ purpose: "answer" | "question"; mode: CaseReplyAiMode; draft: string; text: string }> | null;
  replyLimit: string | null;
  requests: ReadonlyArray<Readonly<{ id: string; family: string; subject: string | null; status: string; action: "answer" | "ask" | "handoff" | "confirm_resolution" | "team_part" | "team" | "none" }>>;
  /** Every refused attempt, in order, with its closed codes. */
  refusals: ReadonlyArray<Readonly<{ call: number; codes: readonly string[] }>>;
  /** The last validation's refusals, with our fixed labels. */
  rejections: ReadonlyArray<Pick<CaseDecisionRejection, "code" | "label" | "path" | "detail">>;
  signals: readonly string[];
  attachments: ReadonlyArray<Readonly<{ id: string; name: string; type: string; kind: string; notAttached: string | null; v1Reading: boolean }>>;
  modelCalls: number; model: string; transport: SavReplayModelTransport["kind"];
  cost: Readonly<{ calls: number; estimatedUsd: number; reservedUsd: number; actualUsd: number }>;
  budget: "ok" | "run_cap" | "mail_cap";
}>;

export type SavReplayDecisionRunOptions = Readonly<{
  model: SavReplayModelTransport; meter: SavReplaySpendMeter; now: Date; mailRef: string;
  /** The cards the replay retrieved for this mail, ranked (the knowledge port of the run: a plain list). */
  knowledge: readonly SavRetrievalCandidate[];
  blockMode: SavBlockMode; locale?: string;
}>;

/** The runner's ports for a replay. Exported for the zero-effect proof: memory, constants and one injected model call, nothing else. */
export function savReplayInvestigationPorts(replay: ReplayCase, options: SavReplayDecisionRunOptions) {
  const progress = new Map<string, CaseInvestigationProgress>(), records: CaseInvestigationRecord[] = [];
  const spend = { calls: 0, estimated: 0, reserved: 0, actual: 0, budget: "ok" as SavReplayDecisionDetail["budget"] };
  const ports: CaseInvestigationPorts = {
    scope: { locale: options.locale ?? "fr-FR", audience: "support" },
    pauseState: async () => "running",
    readCase: async caseId => caseId === replay.snapshot.caseId ? { snapshot: structuredClone(replay.snapshot), events: structuredClone(replay.events) } : null,
    admissionPolicyRevision: async () => SAV_REPLAY_POLICY_REVISION,
    // The admission is decided on the replayed input: a re-evaluation (a write) is never needed, and refused if ever asked.
    reevaluateAdmission: async () => { throw new Error("SAV_REPLAY_NO_WRITE"); },
    claim: async () => ({ token: "sav-replay-lease", actionsPaused: false }),
    release: async () => {},
    knowledge: async () => [...options.knowledge],
    ...(replay.customerContext ? { customerContext: async () => structuredClone(replay.customerContext!) } : {}),
    customerTexts: async () => ({ ...replay.customerTexts }),
    revisions: async () => ({ rules: SAV_REPLAY_POLICY_REVISION, playbookId: "sav-replay", model: options.model.model, prompt: "production" }),
    callModel: async request => {
      const reservation = options.meter.reserve(options.mailRef, options.model.reservePerCallUsd);
      // Nothing is sent: the runner reads a deferral, which consumes no attempt.
      if (!reservation.ok) { spend.budget = reservation.reason; return { status: "deferred" }; }
      spend.calls++; spend.reserved += options.model.reservePerCallUsd;
      try { spend.estimated += options.model.estimateUsd(request); } catch { spend.estimated += options.model.reservePerCallUsd; }
      let answer: Awaited<ReturnType<SavReplayModelTransport["call"]>>;
      try { answer = await options.model.call(request); }
      catch {
        // A thrown transport may have reached the provider: uncertain, its reservation kept, never sent again.
        options.meter.settle(reservation.id, null); spend.actual += options.model.reservePerCallUsd;
        return { status: "failed", uncertain: true };
      }
      options.meter.settle(reservation.id, answer.costUsd);
      spend.actual += answer.costUsd ?? options.model.reservePerCallUsd;
      return answer.result;
    },
    progress: {
      load: async (caseId, inputKey) => structuredClone(progress.get(`${caseId}:${inputKey}`) ?? null),
      save: async (caseId, inputKey, value) => { progress.set(`${caseId}:${inputKey}`, structuredClone(value)); },
    },
    record: async record => { records.push(structuredClone(record)); },
    now: () => options.now,
    readTicketOwner: async () => "v2",
  };
  return { ports, progress, records, spend };
}

const requestAction = (validation: CaseDecisionValidation | null, requestId: string): SavReplayDecisionDetail["requests"][number]["action"] => {
  if (validation?.outcome !== "accepted") return "none";
  const action = validation.decision.nextAction;
  switch (action.kind) {
    case "ask": return action.questions.some(row => row.requestId === requestId) ? "ask" : "none";
    case "answer": return action.requestIds.includes(requestId) ? "answer" : "none";
    case "handoff": return action.requestIds.includes(requestId) ? "handoff" : "none";
    case "confirm_resolution": return action.requestIds.includes(requestId) ? "confirm_resolution" : "none";
    default: return "none";
  }
};

/** Runs the production decision path on one replayed case, in memory, and reads back what the agent would have done and written. */
export async function runSavReplayDecision(source: SavReplayCaseSource, options: SavReplayDecisionRunOptions): Promise<SavReplayDecisionDetail> {
  const replay = source.kind === "synthetic" ? synthesizeSavReplayCase(source, options.now) : adaptSavReplayStoredCase(source, options.now);
  const { ports, progress, records, spend } = savReplayInvestigationPorts(replay, options);
  const report = await runCaseInvestigation(replay.snapshot.caseId, "observe", ports);
  const record = records.at(-1) ?? null, saved = [...progress.values()].at(-1) ?? null;
  const validation: CaseDecisionValidation | null = record?.validation ?? saved?.last ?? null;
  const attempts: CaseInvestigationAttempt[] = record?.attempts ?? saved?.attempts ?? [];
  const refusals = attempts.flatMap(row => row.result === "validated" && row.outcome === "needs_review" ? [{ call: row.call, codes: [...row.codes] }] : []);
  const rejections = validation?.outcome === "needs_review" ? validation.rejections.map(({ code, label, path, detail }) => ({ code, label: label ?? caseDecisionRejectionLabels[code], path, ...(detail === undefined ? {} : { detail }) })) : [];
  const teamParts = new Set((replay.snapshot.admission?.qualification.requests ?? []).filter(row => row.provenance.kind === "team_part").map(row => row.requestId));

  let action: SavReplayDecisionAction = "none", team: SavReplayDecisionDetail["team"] = null, ask: SavReplayDecisionDetail["ask"] = null;
  let reply: SavReplayDecisionDetail["reply"] = null, replyLimit: string | null = null;
  if (record?.refusalHandoff) { action = "team"; team = { reason: record.refusalHandoff.reason, codes: [...record.refusalHandoff.codes] }; replyLimit = "decision_refused"; }
  else if (validation?.outcome === "accepted") {
    const decision = validation.decision, next = decision.nextAction;
    action = next.kind;
    if (next.kind === "handoff") team = { reason: next.reason };
    if (next.kind === "ask") ask = { requestId: next.questions[0]!.requestId, text: next.questions[0]!.text };
    const mode: CaseReplyAiMode = options.blockMode === "automatic" ? "automated" : "manual_reviewed";
    // As the reply passage does (`caseDecisionDraft`): an answer or ONE question is sent; a closure or a handoff waits for its own purpose.
    if (!decision.reply) replyLimit = "no_reply";
    else if (next.kind !== "answer" && next.kind !== "ask") replyLimit = "purpose_not_supported";
    else if (next.kind === "ask" && next.questions.length !== 1) replyLimit = "several_questions";
    else {
      const purpose = next.kind === "answer" ? "answer" as const : "question" as const;
      // French by default: the replay does not resolve the customer's language (`resolveCaseReplyLanguage` reads a stored proof).
      try { reply = { purpose, mode, draft: decision.reply.text, text: prepareCaseReplyText(decision.reply.text, "fr", mode, purpose) }; }
      catch { replyLimit = "reply_empty"; }
    }
  } else if (validation?.outcome === "needs_review") replyLimit = "decision_refused";
  else if (report.status === "skipped") { action = "team"; team = { reason: `gate:${report.reason}${report.detail ? `:${report.detail}` : ""}` }; replyLimit = "not_investigated"; }
  else replyLimit = report.status;

  const requests = replay.snapshot.body.openRequests.map(row => ({ id: row.id, family: row.family, subject: row.subject?.status === "available" ? row.subject.text : null, status: row.status,
    action: teamParts.has(row.id) && row.status === "handed_off" ? "team_part" as const : action === "team" ? "team" as const : requestAction(validation, row.id) }));
  const files = replay.customerContext?.attachments?.files ?? [];
  return {
    runner: report.status, outcome: validation?.outcome ?? null, action, team, ask, reply, replyLimit, requests, refusals, rejections,
    signals: validation ? [...validation.signals] : [],
    attachments: files.map(file => ({ id: file.id, name: file.name, type: file.type, kind: file.kind, notAttached: file.notAttached, v1Reading: file.v1Reading !== null })),
    modelCalls: report.modelCalls, model: options.model.model, transport: options.model.kind,
    cost: { calls: spend.calls, estimatedUsd: spend.estimated, reservedUsd: spend.reserved, actualUsd: spend.actual }, budget: spend.budget,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The replay's decision port
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * The `decide` port of `runSavBlockReplay` on the real decision path: one synthetic case per mail or phrase (its parts and files when the
 * item names them), or the stored case as read. The spend meter is shared by the whole run: once its run cap refuses a call, the replay
 * stops deciding (`budget: "run_cap"`).
 */
export function createSavReplayDecisionPort(options: Readonly<{ model: SavReplayModelTransport; meter: SavReplaySpendMeter; now: Date; locale?: string }>):
  (input: SavReplayDecisionInput) => Promise<SavReplayDecisionOutput> {
  return async input => {
    const item = input.item;
    const extras = item && item.kind !== "case" ? item : undefined;
    const family = savReplayBlockFamily(input.block.blockId, input.block.family);
    const source: SavReplayCaseSource = input.stored
      ? { kind: "stored", blockId: input.block.blockId, stored: input.stored }
      : { kind: "synthetic", ref: input.ref.replace(/^[a-z]+:/, ""), subject: input.subject ?? "", text: input.text, family, blockId: input.block.blockId,
          ...(input.messageId ? { messageId: input.messageId } : {}), ...(extras?.requests ? { requests: extras.requests } : {}), ...(extras?.attachments ? { attachments: extras.attachments } : {}) };
    const detail = await runSavReplayDecision(source, { model: options.model, meter: options.meter, now: options.now, mailRef: input.ref, knowledge: input.candidates ?? [],
      blockMode: input.block.mode, ...(options.locale ? { locale: options.locale } : {}) });
    return { action: detail.action, reply: detail.reply?.text ?? null, refusals: [...new Set(detail.refusals.flatMap(row => row.codes))], costUsd: detail.cost.actualUsd,
      estimatedUsd: detail.cost.estimatedUsd, budget: detail.budget, detail };
  };
}
