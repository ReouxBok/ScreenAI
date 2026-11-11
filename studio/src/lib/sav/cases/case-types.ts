import { z } from "zod";
import { savFactKeySchema } from "../playbook-contract";

/** V2 case contract (SAV-5). Additions need a new revision and a coordinated update of
 * every consumer (decision validator, timers). v2 added structured evidence for SAV-6
 * (fact keys, request families, trial outcomes, event direction and date); v3 added the
 * request opening date and the server admission (SAV-44); v4 adds the V1 relay proof
 * (SAV-11), the decision claim and observation record, and J2 timers kept through a
 * technical pause (SAV-8); v5 lets a fact replace an older one instead of contradicting it; v6 types what a CRM
 * observation changed, so a note alone no longer makes the admission stale; v7 applies Ugo's
 * decisions of 28/10: a technical or organisational hold keeps the J2 (Q9), an attachment is
 * cited by mail and part (Q6), and a customer message never becomes an observed fact (Q8); v8
 * closes the integration findings of 28/10: the V1 relay opens the message's requests (ids
 * `<mail>/<V1 request>`, no customer text) and a CRM key takes an ISO date as milliseconds; v9
 * gives a relayed case to the agent only on V1's verified V2 owner effect; v10 gives each request
 * the relay opens a searchable subject from V1's accepted analysis, or the reason it has none.
 * Older rows are read only through a declared upgrade below; any other revision is refused. */
export const SAV_CASE_CONTRACT_REVISION = "sav-case-2026-10-27.v10";

export const SAV_CASE_OWNERS = ["agent", "human", "system_hold"] as const;
export type CaseOwner = typeof SAV_CASE_OWNERS[number];

export const SAV_CASE_PHASES = [
  "queued", "acting", "awaiting_customer", "closed_no_reply", "resolved",
  "handoff_pending", "human_owned",
  "deferred_budget", "technical_wait", "reconciling", "needs_review", "blocked_technical", "blocked_reconcile",
] as const;
export type CasePhase = typeof SAV_CASE_PHASES[number];

/** Phases a human-owned case may be in; every other phase belongs to the agent.
 * An administrative hold freezes whatever phase the case had. */
export const SAV_CASE_HUMAN_PHASES = ["handoff_pending", "human_owned"] as const satisfies readonly CasePhase[];
export function caseOwnerAllowsPhase(owner: CaseOwner, phase: CasePhase) {
  if (owner === "system_hold") return true;
  return (SAV_CASE_HUMAN_PHASES as readonly CasePhase[]).includes(phase) === (owner === "human");
}

/** Finance and cancellation are human-owned for the whole case; sensitivity never downgrades. */
export const SAV_CASE_SENSITIVITIES = ["none", "finance", "cancellation"] as const;
export type CaseSensitivity = typeof SAV_CASE_SENSITIVITIES[number];

/** Same closed list as the SAV-6 decision contract. Every sensitive family is for a
 * human; only finance and cancellation are also tracked as case sensitivity. */
export const SAV_CASE_SENSITIVE_FAMILIES = ["finance", "cancellation", "subscription", "rights", "identity"] as const;
export const SAV_CASE_REQUEST_FAMILIES = ["access", "usage", "technical", "integration", "telephony", "other", ...SAV_CASE_SENSITIVE_FAMILIES] as const;
export type CaseRequestFamily = typeof SAV_CASE_REQUEST_FAMILIES[number];
/** Case sensitivity a request family requires, if any. */
export function caseSensitivityForFamily(family: CaseRequestFamily): Exclude<CaseSensitivity, "none"> | null {
  return family === "finance" || family === "cancellation" ? family : null;
}

const ref = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(4000);
const at = z.iso.datetime({ offset: true });

/** An attachment is cited as `<gmailMessageId>:<partId>` (V1 inventory, `attachment-contract.ts`):
 * the part id is stable within a mail, unlike Gmail's attachmentId, which may be absent or long. */
export const SAV_CASE_ATTACHMENT_REF = /^([A-Za-z0-9_-]{1,180}):([0-9]{1,9}(?:\.[0-9]{1,9}){0,8})$/;
export const caseAttachmentRef = (gmailMessageId: string, partId: string) => `${gmailMessageId}:${partId}`;
export const sourceRefSchema = z.object({
  type: z.enum(["email", "hubspot_note", "hubspot_email", "hubspot_object", "attachment", "knowledge", "studio_command", "timer"]),
  id: ref, revision: ref.optional(),
}).strict().refine(source => source.type !== "attachment" || SAV_CASE_ATTACHMENT_REF.test(source.id), "ATTACHMENT_REF_INVALID");
export type SourceRef = z.infer<typeof sourceRefSchema>;

/** Same identifiers as retrieval candidates: `id` and `contentVersionId`. */
export const knowledgeRefSchema = z.object({ knowledgeId: ref, contentVersionId: ref }).strict();
export type KnowledgeRef = z.infer<typeof knowledgeRefSchema>;

export const caseFactSchema = z.object({
  id: ref, text, source: sourceRefSchema, at,
  /** Canonical playbook fact key, or null when the fact has none. */
  key: savFactKeySchema.nullable(),
  // A customer's own diagnosis is a statement, never an observed fact: an observed fact cannot
  // cite one of the case's customer mails or their attachments (checked by the store, Q8).
  kind: z.enum(["observed", "customer_statement"]),
  /** Id of the older fact this one corrects (the customer said v2, then v3). Facts are never
   * edited or deleted: the older one stays, superseded. */
  replaces: ref.optional(),
}).strict();
export type CaseFact = z.infer<typeof caseFactSchema>;

const uniqueKeys = z.array(savFactKeySchema).max(5).refine(keys => new Set(keys).size === keys.length, "DUPLICATE_FACT_KEY");
export const SAV_CASE_TRIAL_OUTCOMES = ["pending", "failed", "succeeded", "unknown"] as const;
const caseTrialSchema = z.object({
  id: ref, requestId: ref, procedure: knowledgeRefSchema, askedAt: at,
  outcome: z.enum(SAV_CASE_TRIAL_OUTCOMES), resultAt: at.nullable(),
  result: z.object({ text, source: sourceRefSchema }).strict().optional(),
}).strict().refine(
  // A pending trial has no result yet; a failed or succeeded one says when it was learnt.
  trial => trial.outcome === "pending" ? trial.resultAt === null && !trial.result : trial.outcome === "unknown" || trial.resultAt !== null,
  "TRIAL_OUTCOME_INCONSISTENT",
);
export type CaseTrial = z.infer<typeof caseTrialSchema>;

/** Replacement rules: same key, never weaker evidence (a statement does not override an
 * observation), never older, at most one replacement per fact, no cycle. */
function checkFactReplacements(facts: CaseFact[], issue: (message: string, index: number) => void) {
  const byId = new Map<string, CaseFact>();
  facts.forEach((fact, i) => byId.has(fact.id) ? issue("DUPLICATE_FACT_ID", i) : byId.set(fact.id, fact));
  const replaced = new Set<string>();
  facts.forEach((fact, i) => {
    if (fact.replaces === undefined) return;
    const older = byId.get(fact.replaces);
    if (!older || older.id === fact.id) return issue("FACT_REPLACES_UNKNOWN", i);
    if (replaced.has(older.id)) issue("FACT_REPLACED_TWICE", i);
    replaced.add(older.id);
    if (older.key !== fact.key) issue("FACT_REPLACEMENT_KEY_MISMATCH", i);
    if (older.kind === "observed" && fact.kind === "customer_statement") issue("FACT_REPLACEMENT_WEAKER", i);
    if (Date.parse(fact.at) < Date.parse(older.at)) issue("FACT_REPLACEMENT_OLDER", i);
    // Equal dates could still close a loop: walk the chain.
    const seen = new Set([fact.id]);
    for (let next = older; next?.replaces !== undefined; next = byId.get(next.replaces)!) {
      if (seen.has(next.id)) { issue("FACT_REPLACEMENT_CYCLE", i); break; }
      seen.add(next.id);
    }
  });
}
/** Facts still in force: those no other fact replaces. What a model should be given. */
export function currentCaseFacts(body: Pick<CaseBody, "facts">): CaseFact[] {
  const replaced = new Set(body.facts.flatMap(fact => fact.replaces === undefined ? [] : [fact.replaces]));
  return body.facts.filter(fact => !replaced.has(fact.id));
}

/** A request a customer mail opened (v8): one id per mail and V1 request, so two mails' « r0 »
 * never collide. `message` stands for a confirmed mail whose analysis listed no request. */
export const caseRequestId = (gmailMessageId: string, requestId: string) => `${gmailMessageId}/${requestId}`;
export const SAV_CASE_OPEN_REQUESTS_MAX = 50;

/** v10: why a request has no searchable subject. `not_recorded`: opened before v10 or by a person;
 * `source_missing`: no accepted V1 analysis of that run lists the request; `source_invalid`: the
 * stored analysis fails its own hashes; `source_ambiguous`: two accepted analyses disagree;
 * `not_in_summary`: V1's summary does not cover it; `summary_shared`: V1 summed up several requests
 * at once, so the text is not this request's subject; `redacted_empty`: nothing left once masked. */
export const SAV_CASE_SUBJECT_ABSENCES = ["not_recorded", "source_missing", "source_invalid", "source_ambiguous", "not_in_summary", "summary_shared", "redacted_empty"] as const;
export type CaseSubjectAbsence = typeof SAV_CASE_SUBJECT_ABSENCES[number];
export const SAV_CASE_SUBJECT_LENGTH = { min: 3, max: 600 } as const;
/** What the investigation may search for one request (v10). Only V1's `ticketSummary` of an
 * accepted analysis, masked, and only when it covers this request alone; never the mail itself. */
export const caseRequestSubjectSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available"), text: z.string().trim().min(SAV_CASE_SUBJECT_LENGTH.min).max(SAV_CASE_SUBJECT_LENGTH.max),
    provenance: z.object({ source: z.literal("v1_accepted_analysis"), field: z.literal("ticketSummary"), runId: z.string().uuid(), runVersion: z.number().int().min(1),
      resultHash: ref, validatorRevision: ref, acceptedAt: at }).strict() }).strict(),
  z.object({ status: z.literal("absent"), reason: z.enum(SAV_CASE_SUBJECT_ABSENCES) }).strict(),
]);
export type CaseRequestSubject = z.infer<typeof caseRequestSubjectSchema>;
/** The subject of a stored request; a request without one (v9 or opened by a person) is `not_recorded`. */
export const caseRequestSubject = (request: { subject?: CaseRequestSubject }): CaseRequestSubject => request.subject ?? { status: "absent", reason: "not_recorded" };
/** B's `subjectOf` port: the text to search, or null. Never the generic `summary` label. */
export const caseRequestSearchText = (request: { subject?: CaseRequestSubject }) => {
  const subject = caseRequestSubject(request);
  return subject.status === "available" ? subject.text : null;
};

export const caseBodySchema = z.object({
  /** `openedAt`: when the customer first raised this request (spontaneous resolution is dated from it). */
  openRequests: z.array(z.object({ id: ref, summary: text, family: z.enum(SAV_CASE_REQUEST_FAMILIES), status: z.enum(["open", "resolved", "handed_off"]), openedAt: at,
    subject: caseRequestSubjectSchema.optional() }).strict()).max(SAV_CASE_OPEN_REQUESTS_MAX),
  facts: z.array(caseFactSchema).max(500),
  hypotheses: z.array(z.object({ id: ref, text, supportedBy: z.array(ref).max(50), status: z.enum(["open", "confirmed", "rejected"]) }).strict()).max(100),
  /** `factKeys`: what the question asked for, so an answer is matched by key, not by text. */
  questions: z.array(z.object({ id: ref, text, factKeys: uniqueKeys, askedAt: at, askedInEffect: ref, answeredBy: sourceRefSchema.optional() }).strict()).max(200),
  trials: z.array(caseTrialSchema).max(200),
  waiting: z.object({ kind: z.enum(["customer", "team", "technical"]), since: at, dueAt: at.optional(), reasonCode: ref, timerId: ref.optional() }).strict().nullable(),
  handoff: z.object({ reason: ref, slackThread: ref.optional(), postedEffect: ref.optional(), humanSince: at.optional() }).strict().nullable(),
  cycle: z.object({ number: z.number().int().min(1), endedBy: z.enum(["resolved", "closed_no_reply", "handoff"]).optional() }).strict(),
  /** Revisions behind the last accepted decision; null until a decision exists. */
  revisions: z.object({ rules: ref, playbookId: ref, model: ref, prompt: ref }).strict().nullable(),
}).strict().superRefine((body, ctx) => {
  const requests = new Set(body.openRequests.map(request => request.id));
  if (requests.size !== body.openRequests.length) ctx.addIssue({ code: "custom", message: "DUPLICATE_REQUEST_ID", path: ["openRequests"] });
  body.trials.forEach((trial, i) => {
    if (!requests.has(trial.requestId)) ctx.addIssue({ code: "custom", message: "TRIAL_REQUEST_UNKNOWN", path: ["trials", i, "requestId"] });
  });
  checkFactReplacements(body.facts, (message, i) => ctx.addIssue({ code: "custom", message, path: ["facts", i] }));
});
export type CaseBody = z.infer<typeof caseBodySchema>;

/** Declared upgrades from an older stored revision to the current body. v3 to v9 bodies
 * are already valid v10 bodies (v4, v6, v7, v8 and v9 changed no body field, v5 only adds `replaces`,
 * v10 only adds an optional `subject`, read as `not_recorded` when absent).
 * v1/v2 bodies lack required fields (family, opening date) and are refused, never guessed. */
export const SAV_CASE_CONTRACT_UPGRADES: Readonly<Record<string, (body: unknown) => unknown>> = {
  "sav-case-2026-10-27.v3": body => body,
  "sav-case-2026-10-27.v4": body => body,
  "sav-case-2026-10-27.v5": body => body,
  "sav-case-2026-10-27.v6": body => body,
  "sav-case-2026-10-27.v7": body => body,
  "sav-case-2026-10-27.v8": body => body,
  "sav-case-2026-10-27.v9": body => body,
};

export function emptyCaseBody(): CaseBody {
  return { openRequests: [], facts: [], hypotheses: [], questions: [], trials: [], waiting: null, handoff: null, cycle: { number: 1 }, revisions: null };
}

/** Admission (SAV-44): whether the agent may own the case. Exclusions first, then a
 * positive list. An intake category is a hint: it can exclude, never admit. */
export const SAV_CASE_ADMISSION_REVISION = "sav-admission-2026-10-27.v1";
/** The only families an admission policy may list. */
export const SAV_CASE_ADMISSIBLE_FAMILIES = ["access", "usage"] as const;
export const SAV_CASE_ADMISSION_TARGETS = ["agent", "team", "qualification"] as const;
export type CaseAdmissionTarget = typeof SAV_CASE_ADMISSION_TARGETS[number];
/** In decision order; the first applicable reason sets the target. */
export const SAV_CASE_ADMISSION_REASONS = [
  "case_sensitive", "sensitive_family", "mixed_sensitive", "confirmed_bug", "out_of_capability",
  "policy_missing", "policy_invalid", "no_request", "family_unknown", "identity_unconfirmed", "context_incomplete",
  "family_not_admitted", "qualification_unproven", "admitted",
] as const;
export type CaseAdmissionReason = typeof SAV_CASE_ADMISSION_REASONS[number];
export const SAV_CASE_ADMISSION_TEAM_REASONS: readonly CaseAdmissionReason[] = ["case_sensitive", "sensitive_family", "mixed_sensitive", "confirmed_bug", "out_of_capability"];
/** Public French wording for the console; codes stay the stable contract. */
export const SAV_CASE_ADMISSION_REASON_LABELS: Record<CaseAdmissionReason, string> = {
  case_sensitive: "Dossier finance ou résiliation : traité par l'équipe.",
  sensitive_family: "Demande finance, résiliation, abonnement, droits ou identité : traitée par l'équipe.",
  mixed_sensitive: "Dossier mixte avec une demande sensible : tout le dossier reste à l'équipe.",
  confirmed_bug: "Bug confirmé : transmis à l'équipe.",
  out_of_capability: "Hors des capacités de l'agent : transmis à l'équipe.",
  policy_missing: "Aucune politique d'admission approuvée : qualification par l'équipe.",
  policy_invalid: "Politique d'admission illisible : qualification par l'équipe.",
  no_request: "Aucune demande identifiée : qualification par l'équipe.",
  family_unknown: "Nature de la demande non qualifiée : qualification par l'équipe.",
  identity_unconfirmed: "Identité du client non confirmée : qualification par l'équipe.",
  context_incomplete: "Contexte CRM incomplet : qualification par l'équipe.",
  family_not_admitted: "Famille de demande non autorisée pour l'agent : qualification par l'équipe.",
  qualification_unproven: "Famille non qualifiée par une source reconnue : qualification par l'équipe.",
  admitted: "Admis pour l'agent.",
};

const staffId = z.string().uuid();
const admissibleFamilies = z.array(z.enum(SAV_CASE_ADMISSIBLE_FAMILIES)).min(1).max(SAV_CASE_ADMISSIBLE_FAMILIES.length)
  .refine(values => new Set(values).size === values.length, "DUPLICATE_FAMILY");
/** Approved by Ugo; none exists yet, and `null` admits nobody. */
export const caseAdmissionPolicySchema = z.object({
  revision: ref, admittedFamilies: admissibleFamilies,
  qualifiedRules: z.array(z.object({ ruleId: ref, revision: ref, families: admissibleFamilies }).strict()).max(20),
  approvedBy: staffId, approvedAt: at,
}).strict();
export type CaseAdmissionPolicy = z.infer<typeof caseAdmissionPolicySchema>;

/** Treatment blocks (11/11, `case-blocks.ts`): a block's identity, distinct from its family. The family `access` is the `access` block's alone. */
export const SAV_CASE_ACCESS_BLOCK_ID = "access";
export const SAV_CASE_BLOCK_ID = /^[a-z][a-z0-9_-]{1,39}$/;
export const caseBlockIdSchema = z.string().regex(SAV_CASE_BLOCK_ID);

export const caseAdmissionProvenanceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human"), staffUserId: staffId, at }).strict(),
  // Admits only when the policy lists this rule and revision for the family. `blockId`: the block the rule names; absent for a
  // rule written before blocks (then only the family `access` has one, the Access block), so Access records exactly what it did.
  z.object({ kind: z.literal("qualified_rule"), ruleId: ref, revision: ref, at, blockId: caseBlockIdSchema.optional() }).strict(),
  // An intake category proposed by the model: may exclude, never admits.
  z.object({ kind: z.literal("intake_hint"), source: sourceRefSchema }).strict(),
]);
export const caseAdmissionQualificationSchema = z.object({
  requests: z.array(z.object({ requestId: ref, family: z.enum([...SAV_CASE_REQUEST_FAMILIES, "unknown"]), provenance: caseAdmissionProvenanceSchema }).strict()).max(20),
  identity: z.object({ status: z.enum(["confirmed", "ambiguous", "absent", "unknown"]), source: sourceRefSchema.optional() }).strict()
    .refine(identity => identity.status !== "confirmed" || identity.source !== undefined, "IDENTITY_SOURCE_REQUIRED"),
  // A failed or partial CRM read proves nothing.
  crmContext: z.enum(["complete", "incomplete", "unknown"]),
  teamSignals: z.array(z.object({ kind: z.enum(["confirmed_bug", "out_of_capability"]), source: sourceRefSchema }).strict()).max(10),
}).strict();
export type CaseAdmissionQualification = z.infer<typeof caseAdmissionQualificationSchema>;

export type CaseAdmissionDecision = {
  revision: typeof SAV_CASE_ADMISSION_REVISION;
  target: CaseAdmissionTarget;
  reasons: CaseAdmissionReason[];
  nextStep: "none" | "team_takeover" | "qualify";
  families: (CaseRequestFamily | "unknown")[];
  sensitivity: CaseSensitivity;
  policyRevision: string | null;
};
export type CaseAdmissionRecord = CaseAdmissionDecision & {
  decidedAt: string;
  /** Case version right after this admission was recorded. */
  version: number;
  /** Version of the latest input it took into account. */
  inputVersion: number;
  qualification: CaseAdmissionQualification;
};
/** What a `crm_observed` event saw change (`detail.crmChange`). Untyped means `unknown`. */
export const SAV_CASE_CRM_CHANGES = ["note_added", "status_changed", "owner_changed", "properties_changed", "unknown"] as const;
export type CaseCrmChange = typeof SAV_CASE_CRM_CHANGES[number];
/** Inputs after which a recorded admission is stale until re-evaluated. A CRM note alone is
 * not one (decision Ugo 27/10: relaunch only on a real new input); it stays in the journal.
 * Any other or untyped CRM change is, so a status moved to « Nouveau » is never a permission. */
export function caseEventIsAdmissionInput(kind: CaseEventKind, direction: CaseEventDirection, crmChange: CaseCrmChange = "unknown") {
  if (kind === "crm_observed") return crmChange !== "note_added";
  return kind === "inbound_confirmed" || kind === "human_command" || (kind === "outbound_observed" && direction === "human_outbound");
}

/** Authoritative read of one case. `version` is the CAS token for every write. */
export type CaseSnapshot = {
  contractRevision: typeof SAV_CASE_CONTRACT_REVISION;
  caseId: string;
  ticketId: string;
  threadIds: string[];
  version: number;
  owner: CaseOwner;
  phase: CasePhase;
  sensitivity: CaseSensitivity;
  createdAt: string;
  updatedAt: string;
  body: CaseBody;
  /** Latest admission; never written through the body. */
  admission: CaseAdmissionRecord | null;
  admissionInputVersion: number;
};

export const SAV_CASE_EVENT_KINDS = ["inbound_confirmed", "outbound_observed", "timer_fired", "human_command", "crm_observed", "owner_changed", "admission_decided", "observation_recorded"] as const;
export type CaseEventKind = typeof SAV_CASE_EVENT_KINDS[number];

/** Who a message came from. `internal` covers timers, commands, CRM and owner changes. */
export const SAV_CASE_EVENT_DIRECTIONS = ["customer_inbound", "agent_outbound", "human_outbound", "internal"] as const;
export type CaseEventDirection = typeof SAV_CASE_EVENT_DIRECTIONS[number];
export const SAV_CASE_EVENT_KIND_DIRECTIONS: Record<CaseEventKind, readonly CaseEventDirection[]> = {
  inbound_confirmed: ["customer_inbound"],
  outbound_observed: ["agent_outbound", "human_outbound"],
  timer_fired: ["internal"], human_command: ["internal"], crm_observed: ["internal"], owner_changed: ["internal"], admission_decided: ["internal"],
  observation_recorded: ["internal"],
};

/** Idempotence is per (caseId, dedupeKey): one mail may legitimately feed two tickets. */
const keyPart = "[A-Za-z0-9._@<>=+-]{1,200}";
export const SAV_CASE_DEDUPE_PATTERNS: Record<CaseEventKind, RegExp> = {
  inbound_confirmed: new RegExp(`^inbound:${keyPart}$`),
  outbound_observed: new RegExp(`^outbound:${keyPart}$`),
  timer_fired: new RegExp(`^timer:${keyPart}$`),
  human_command: new RegExp(`^cmd:${keyPart}$`),
  crm_observed: new RegExp(`^crm:${keyPart}:${keyPart}$`),
  owner_changed: new RegExp(`^(cmd|rule):${keyPart}(:${keyPart})?$`),
  admission_decided: new RegExp(`^admission:v[0-9]{1,9}:${keyPart}$`),
  observation_recorded: new RegExp(`^observation:${keyPart}$`),
};
const crmDateTime = z.iso.datetime({ offset: true });
/** HubSpot gives `updatedAt` as an ISO date or as milliseconds; the key always holds milliseconds
 * (`:` is not a key character), so one update read in both formats is one event. */
function crmUpdatedAtMs(updatedAt: string) {
  if (/^[0-9]{1,15}$/.test(updatedAt)) return String(Number(updatedAt));
  if (crmDateTime.safeParse(updatedAt).success) return String(Date.parse(updatedAt));
  throw Error("SAV_CASE_CRM_DATE_INVALID");
}
export const caseDedupeKey = {
  inbound: (gmailMessageId: string) => `inbound:${gmailMessageId}`,
  /** A sent message seen in Gmail or HubSpot, whether the agent or a human wrote it. */
  outbound: (messageId: string) => `outbound:${messageId}`,
  timer: (timerId: string) => `timer:${timerId}`,
  command: (commandKey: string) => `cmd:${commandKey}`,
  crm: (objectId: string, updatedAt: string) => `crm:${objectId}:${crmUpdatedAtMs(updatedAt)}`,
  sensitiveRule: (gmailMessageId: string) => `rule:sensitive:${gmailMessageId}`,
  /** `version`: case version the admission is recorded at. */
  admission: (version: number, policyRevision: string | null) => `admission:v${version}:${policyRevision ?? "none"}`,
  admissionRule: (version: number) => `rule:admission:v${version}`,
  /** Q5: a relayed mail found the case memory full (`version`: the event's). */
  memoryFull: (version: number) => `rule:memory-full:v${version}`,
  /** One observation per claim: a replayed write records nothing. */
  observation: (claimToken: string) => `observation:${claimToken}`,
};

export type CaseEvent = {
  id: string;
  caseId: string;
  kind: CaseEventKind;
  dedupeKey: string;
  /** Case version right after this event was appended. */
  caseVersion: number;
  direction: CaseEventDirection;
  /** When the source happened (message received or sent); `createdAt` is when it was recorded. */
  occurredAt: string;
  sourceRef: SourceRef;
  detail: Record<string, unknown> | null;
  createdAt: string;
};

export type CaseActor = { type: "agent" } | { type: "system" } | { type: "human"; staffUserId: string };

/** Owner changes exist only as these explicit transitions. Authorisation of the
 * human actor (admin, support member) is the caller's job: no route exists yet.
 * Holds (decision Ugo 28/10, Q9): a technical or organisational hold is temporary and keeps
 * the J2 with its due date; nothing fires while held, and `hold_release` to the agent needs a
 * fresh admission. A personal human takeover cancels it. `admin_hold`, which mixed both, is
 * retired: still readable in older journals, refused as a new command. */
export const SAV_CASE_OWNER_TRANSITIONS = {
  handoff: { from: ["agent"], actors: ["agent", "human"] },
  human_takeover: { from: ["agent", "human"], actors: ["human", "system"] },
  hand_back: { from: ["human"], actors: ["human"] },
  technical_hold: { from: ["agent", "human"], actors: ["human", "system"] },
  organisational_hold: { from: ["agent", "human"], actors: ["human"] },
  admin_hold: { from: ["agent", "human"], actors: ["human"] },
  hold_release: { from: ["system_hold"], actors: ["human"] },
  // v9: only the relay, on V1's verified V2 owner effect or the V2 owner read now (CaseAttributionProof), and only from
  // a case still waiting for it that nobody took (SAV_CASE_AWAITING_V2_ATTRIBUTION).
  v2_attribution: { from: ["human"], actors: ["system"] },
} as const satisfies Record<string, { from: readonly CaseOwner[]; actors: readonly CaseActor["type"][] }>;
export type CaseOwnerTransition = keyof typeof SAV_CASE_OWNER_TRANSITIONS;
export const SAV_CASE_RETIRED_TRANSITIONS: readonly CaseOwnerTransition[] = ["admin_hold"];
export const SAV_CASE_HOLDS_KEEPING_TIMERS: readonly CaseOwnerTransition[] = ["technical_hold", "organisational_hold"];
/** v9: team reason of an admitted case whose HubSpot ticket does not carry the V2 owner yet.
 * Every case the relay creates for the agent starts here; only `v2_attribution` leaves it to the agent. */
export const SAV_CASE_AWAITING_V2_ATTRIBUTION = "awaiting_v2_attribution";
export function caseAwaitsV2Attribution(current: Pick<CaseSnapshot, "owner" | "phase" | "body">) {
  return current.owner === "human" && current.phase === "handoff_pending" && current.body.handoff?.reason === SAV_CASE_AWAITING_V2_ATTRIBUTION && !current.body.handoff.humanSince;
}

/** Why an inbound message reached its case (SAV-11), taken from V1's durable records only.
 * A relay never stands for a CRM receipt it does not have, and an uncertain V1 effect is
 * no proof at all. Stored as `detail.relay` on `inbound_confirmed`. */
const uuid = z.string().uuid();
export const caseRelayProofSchema = z.discriminatedUnion("kind", [
  // Every effect V1 required for this message is confirmed; the ticket is the execution's.
  z.object({ kind: z.literal("intake_effects_confirmed"), messageId: uuid, executionId: uuid, intakeRunId: uuid.nullable(), intakeRunVersion: z.number().int().min(1) }).strict(),
  // V1 classified it as an acknowledgement needing no CRM effect; its thread already
  // belongs to exactly one case, which is the one fed.
  z.object({ kind: z.literal("acknowledgement_on_case_thread"), messageId: uuid, intakeRunId: uuid, intakeRunVersion: z.number().int().min(1), sourceHash: ref }).strict(),
]);
export type CaseRelayProof = z.infer<typeof caseRelayProofSchema>;
/** Pilot access (3/11), route 3A: V1's confirmed `ticket_create` of the relayed execution, whose stored
 * intent (hash checked) created this very ticket with the V2 owner in the creation itself. Nobody can own
 * a ticket before it exists, so no person is overwritten; no owner is ever written afterwards. */
export const caseOwnerAtCreationProofSchema = z.object({
  kind: z.literal("hubspot_owner_at_creation"), executionId: uuid, effectId: uuid,
  ticketId: z.string().regex(/^[0-9]{1,30}$/), ownerId: z.string().regex(/^[0-9]{1,20}$/), intentHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type CaseOwnerAtCreationProof = z.infer<typeof caseOwnerAtCreationProofSchema>;
/** v9: V1's `owner_assign` effect of the relayed execution, confirmed by reading the V2 owner back
 * on the ticket (V1 no longer plans it since review R1), or (3/11) the owner set at creation. Read from
 * the V1 ledger by the relay, never declared by a caller; the store reads the same row again. */
export const caseAttributionProofSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("hubspot_owner_verified"), executionId: uuid, effectId: uuid, ticketId: z.string().regex(/^[0-9]{1,30}$/), ownerId: z.string().regex(/^[0-9]{1,20}$/),
  }).strict(),
  caseOwnerAtCreationProofSchema,
  /* Ugo (4/11): attribution and processing are two things. A ticket whose CURRENT HubSpot owner reads as the V2 owner, on a mail V1 confirmed on that ticket, needs no owner effect
   * of V1: the reading is the proof, nothing is written, and no compare-and-set is asked because nothing is taken from anyone. */
  z.object({ kind: z.literal("hubspot_owner_read"), messageId: uuid, ticketId: z.string().regex(/^[0-9]{1,30}$/), ownerId: z.string().regex(/^[0-9]{1,20}$/) }).strict(),
]);
export type CaseAttributionProof = z.infer<typeof caseAttributionProofSchema>;

/** Decision claim (SAV-6/7): one live claim per case, taken on an exact version and only
 * with a fresh positive admission. It is neither a budget nor an attempt counter: model
 * calls stay on their existing ledger. */
export type CaseClaim = { caseId: string; token: string; version: number; holder: string; until: string };
/** Quiet period after the last recorded customer message before a decision may be claimed, so a
 * burst of mails is analysed once. Product decision by Ugo, 27/10: 5 minutes. */
export const SAV_CASE_INBOUND_SETTLE_SECONDS = 300;
export const SAV_CASE_CLAIM_REFUSALS = [
  "owner_not_agent", "no_admission", "not_admitted", "input_newer", "policy_missing", "policy_changed", "claimed_elsewhere", "agent_paused", "inbound_settling",
] as const;
export type CaseClaimRefusal = typeof SAV_CASE_CLAIM_REFUSALS[number];

/** What a claim holder stores: its own record (decision, readings, refusal cause), opaque
 * here and encrypted with the event, plus an optional next body and phase. Applied to the
 * case only if nothing moved since the claim; otherwise kept, not applied. */
export const caseObservationSchema = z.object({
  record: z.record(z.string(), z.unknown()),
  body: caseBodySchema.optional(),
  phase: z.enum(SAV_CASE_PHASES).optional(),
}).strict();
export type CaseObservation = z.infer<typeof caseObservationSchema>;
export const SAV_CASE_OBSERVATION_NOT_APPLIED = ["version_moved", "admission_lost"] as const;

/** J2 follow-up timers (SAV-8). A technical pause never cancels one: it stays scheduled,
 * keeps its due date, and only what fires or sends checks the pause. A technical or
 * organisational hold of the case keeps it too, and it does not fire while the case is held. These reasons are the
 * only cancellations, each recorded in the transaction of its signal. */
export const SAV_CASE_TIMER_STATES = ["scheduled", "fired", "cancelled"] as const;
export type CaseTimerState = typeof SAV_CASE_TIMER_STATES[number];
export const SAV_CASE_TIMER_CANCEL_REASONS = ["customer_inbound", "owner_changed", "human_outbound", "new_question", "admission_withdrawn"] as const;
export type CaseTimerCancelReason = typeof SAV_CASE_TIMER_CANCEL_REASONS[number];
export type CaseTimer = {
  id: string; key: string; caseId: string; questionEffectId: string;
  sentAt: string; dueAt: string; state: CaseTimerState; scheduledAtCaseVersion: number;
  firedAt: string | null; cancelledAt: string | null; cancelReason: CaseTimerCancelReason | null;
};
/** `caseId` is a uuid, so it never contains ":" and the key stays unambiguous. */
export const caseTimerKey = (caseId: string, questionEffectId: string) => `timer:j2:${caseId}:${questionEffectId}`;

/**
 * Lot A6 (OBS1 phase 1): why the re-qualification of a stale admission cannot run before any claim, as closed codes.
 * `contract_blocked`: the journal or V1's records say no, and reading again changes nothing until they change.
 * `technical`: a source could not be read; the next pass may succeed. None of them is an admission, a right or an
 * action: they explain a wait, nothing more. Nothing is recorded for them in this phase.
 */
export const SAV_CASE_QUALIFICATION_BLOCKS = [
  "handback_unproven", "acknowledgement_input", "relay_proof_invalid", "v1_source_mismatch", "v1_requests_mismatch", "rule_invalid",
  "v1_context_unavailable", "rule_unavailable", "policy_unavailable",
] as const;
export type CaseQualificationBlock = typeof SAV_CASE_QUALIFICATION_BLOCKS[number];
export type CaseQualificationBlockNature = "contract_blocked" | "technical";
export const SAV_CASE_QUALIFICATION_BLOCK_NATURES: Readonly<Record<CaseQualificationBlock, CaseQualificationBlockNature>> = {
  handback_unproven: "contract_blocked", acknowledgement_input: "contract_blocked", relay_proof_invalid: "contract_blocked",
  v1_source_mismatch: "contract_blocked", v1_requests_mismatch: "contract_blocked", rule_invalid: "contract_blocked",
  v1_context_unavailable: "technical", rule_unavailable: "technical", policy_unavailable: "technical",
};
/** The blocks the case's own journal shows, without reading V1: the only ones a read-only diagnostic may name. */
export const SAV_CASE_JOURNAL_QUALIFICATION_BLOCKS = ["handback_unproven", "acknowledgement_input", "relay_proof_invalid"] as const satisfies readonly CaseQualificationBlock[];
export type CaseJournalQualificationBlock = typeof SAV_CASE_JOURNAL_QUALIFICATION_BLOCKS[number];

export const SAV_CASE_QUALIFICATION_DIAGNOSTIC_REVISION = "sav-case-qualification-diagnostic.v1" as const;
/**
 * Read-only diagnostic of a case's admission freshness (`readCaseQualificationDiagnostic`). No customer text, no Gmail
 * or CRM id, no raw error. `since` is when the input to re-qualify occurred, never when something failed, and never
 * the last admission decision. `stale_ready` only says the journal holds a canonical relayed mail a re-qualification
 * may be tried on: no qualification, identity, family, admission or right is proven by it. Causes seen only by a
 * V1 lookup or at run time are not recorded in this phase: `runtimeCause` says so instead of guessing.
 */
export type CaseQualificationDiagnostic = {
  revision: typeof SAV_CASE_QUALIFICATION_DIAGNOSTIC_REVISION;
  caseId: string;
  caseVersion: number;
  state: "current" | "stale_ready" | "stale_blocked" | "stale_unknown" | "no_customer_input";
  inputVersion: number;
  inputKey: string | null;
  since: string | null;
  block: CaseJournalQualificationBlock | null;
  nature: "contract_blocked" | null;
  runtimeCause: "not_recorded";
};
