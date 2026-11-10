import "server-only";
import { readConfirmedV1Context } from "./admission-context-reader";
import { caseInvestigationQualify, type CaseApprovedRulePort } from "./admission-investigation-ports";
import { caseTicketOwnerPortFromTransport } from "./admission-owner-reader";
import type { AdmissionPolicyRecord, V1AdmissionAdapterPolicy } from "./admission-runtime";
import type { CaseReplyStoreDeps } from "./case-reply-store";
import type { CaseTicketOwnerPort } from "./case-ticket-owner";
import { SAV_CASE_DECISION_CONTRACT_REVISION } from "./decision-contract";
import { caseProvenanceReaders } from "./investigation-pilot-readers";
import { bindCaseInvestigationToReplyPlan, type CaseReplyPassageDeps, type CaseReplyPlanBinding } from "./investigation-reply-passage";
import { caseInvestigationReturnAwareQualify, caseReturnContentRule } from "./investigation-return-qualify";
import { caseCallLedgerOnStore, type CaseInvestigationRuntimeDeps } from "./investigation-runtime";
import {
  caseCustomerTextsReader, caseGeminiDecisionProvider, caseGeminiEmbeddingTransport, caseHubspotOwnerReadTransport, caseKnowledgeVectorSearch,
  caseV2PauseState, caseV2ProviderConfigProblems, SAV_CASE_INVESTIGATION_PROMPT_REVISION, SAV_V2_MODEL_ENV, type CaseV2Network,
} from "./investigation-v2-providers";
import { caseV2EmbeddingSpend, caseV2ModelSpend, readCaseV2SpendPolicy, readCaseV2TransportPolicy } from "./investigation-v2-spend";
import { pilotProvenanceGate, type PilotProvenanceDeps } from "./pilot-passage-provenance";
import { readSavV2QualificationScope } from "./qualification-scope";

/*
 * B (4/11, LOCAL and OFF): the concrete factory of the V2 investigation, for A's trigger and the wake. One real adapter per port, nothing
 * mocked on the normal path: the V2 vector index, Gemini embedding and generation over `network`, A's call ledger, the V2 spend register
 * (embedding and model budgets, never V1's), the global pause, the HubSpot owner read, the stored customer texts, the return-aware
 * qualification and the configured access scope. Any missing proof (switch, policy reader, key, model, spend policy) is a precise refusal
 * and nothing is built: no call can be paid without an approved V2 amount.
 */

type Env = Readonly<Record<string, string | undefined>>;
export const SAV_V2_INVESTIGATION_ENV = "SAV_V2_INVESTIGATION";

export type CaseInvestigationV2Input = Readonly<{
  /** Read at each call, never frozen. */
  env: () => Env;
  /**
   * SAV-80: may V2 still spend on THIS case (the qualification scope, read now)? Composed into the pause port, so the runner and the
   * retrieval read it at the start, before every embedding, after every dispatch mark and before every model call: false, or a failed read, is a
   * full pause for this case only. Absent: the global pause alone, as before.
   */
  caseAllowed?: () => Promise<boolean>;
  /** A's approved admission policy record: REQUIRED, no default (none exists in the repository). */
  readPolicyRecord: (() => Promise<AdmissionPolicyRecord | null>) | null | undefined;
  network?: CaseV2Network;
  now?: () => Date;
  holder?: string;
  leaseSeconds?: number;
  scope?: Readonly<{ locale: string; audience: "support" | "lead" }>;
  /** The owner port the wake already built (C `createCaseTicketOwnerPort`); absent, the GET-only HubSpot read here. */
  readTicketOwner?: CaseTicketOwnerPort;
  /** A's D-a adapter policy; absent, null: V1's identity stays out of V2 admission. */
  adapterPolicy?: () => Promise<V1AdmissionAdapterPolicy | null>;
  /** A's approved V1 rules; absent, V1 hints only (nobody admitted on them). */
  approvedRules?: CaseApprovedRulePort;
  /** The return rule's id and revision AS APPROVED in the policy; absent, nobody is admitted on a customer return. */
  returnRule?: Readonly<{ ruleId: string; revision: string }>;
}>;

export type CaseInvestigationV2Factory =
  | Readonly<{ ok: true; deps: CaseInvestigationRuntimeDeps; provenance: PilotProvenanceDeps }>
  | Readonly<{ ok: false; refusals: readonly string[] }>;

/**
 * SAV-80. The global pause; then a closed qualification scope (expired, not open, invalid, JSON without the mode), read from the env at every
 * look and without any database read, is a full pause for every caller; then, when given, the per-case permission (thread bound, configuration
 * unchanged), whose false or failed read is a full pause for this case.
 */
function casePauseState(global: CaseInvestigationRuntimeDeps["pauseState"], env: () => Env, now: () => Date, caseAllowed: CaseInvestigationV2Input["caseAllowed"]): CaseInvestigationRuntimeDeps["pauseState"] {
  return async () => {
    const level = await global();
    if (level === "fully_paused" || readSavV2QualificationScope(env(), now()).mode === "closed") return "fully_paused";
    if (!caseAllowed) return level;
    return await caseAllowed().catch(() => false) ? level : "fully_paused";
  };
}

/** The V2 investigation's runtime ports and provenance readers, or every precise reason why none is built. */
export function createCaseInvestigationV2Deps(input: CaseInvestigationV2Input): CaseInvestigationV2Factory {
  const env = input.env(), refusals: string[] = [];
  if (env[SAV_V2_INVESTIGATION_ENV] !== "observe") refusals.push("v2_investigation_off");
  if (typeof input.readPolicyRecord !== "function") refusals.push("admission_policy_reader_absent");
  refusals.push(...caseV2ProviderConfigProblems(env));
  const spend = readCaseV2SpendPolicy(env);
  if (!spend.ok) refusals.push(spend.reason);
  try { if (spend.ok) readCaseV2TransportPolicy(env, input.now?.() ?? new Date()); } catch { refusals.push("v2_transport_policy_invalid"); }
  if (refusals.length) return { ok: false, refusals };
  const now = input.now ?? (() => new Date()), readPolicyRecord = input.readPolicyRecord!, scope = input.scope ?? { locale: "fr-FR", audience: "support" as const };
  const spendDeps = { env: input.env, now }, model = caseV2ModelSpend(spendDeps);
  const provenance = caseProvenanceReaders({ readPolicyRecord, env: input.env, now, locale: scope.locale, audience: scope.audience });
  const vectors = caseKnowledgeVectorSearch({ ...scope, now });
  const readTicketOwner = input.readTicketOwner
    ?? (snapshot => caseTicketOwnerPortFromTransport({ transport: caseHubspotOwnerReadTransport({ env: input.env, ...(input.network ? { network: input.network } : {}) }), env: input.env() })(snapshot));
  const v1Qualify = caseInvestigationQualify({ readConfirmedContext: readConfirmedV1Context, adapterPolicy: input.adapterPolicy ?? (async () => null), readPolicyRecord, now,
    ...(input.approvedRules ? { approvedRules: input.approvedRules } : {}) });
  const deps: CaseInvestigationRuntimeDeps = {
    mode: "observe", holder: input.holder ?? "sav-v2-investigation", scope, now, leaseSeconds: input.leaseSeconds ?? 90,
    pauseState: casePauseState(caseV2PauseState(), input.env, now, input.caseAllowed), readTicketOwner, accessScope: provenance.accessScope, admissionPolicyRevision: provenance.currentPolicyRevision,
    qualify: caseInvestigationReturnAwareQualify(v1Qualify, { readPolicyRecord, now, ...(input.returnRule ? { returnRules: caseReturnContentRule(input.returnRule, now) } : {}) }),
    customerTexts: caseCustomerTextsReader(),
    // What the decision rests on, read now: the contract, the active knowledge revision, the configured model and this prompt.
    revisions: async () => ({ rules: SAV_CASE_DECISION_CONTRACT_REVISION, playbookId: await vectors.readRevision(), model: input.env()[SAV_V2_MODEL_ENV] ?? "", prompt: SAV_CASE_INVESTIGATION_PROMPT_REVISION }),
    ledger: caseCallLedgerOnStore,
    knowledge: { vectors, embed: caseGeminiEmbeddingTransport({ env: input.env, ...(input.network ? { network: input.network } : {}) }), spend: caseV2EmbeddingSpend(spendDeps) },
    model: { money: model.money, releaseMoney: model.release, provider: model.provider(caseGeminiDecisionProvider({ env: input.env, ...(input.network ? { network: input.network } : {}) })) },
  };
  return { ok: true, deps, provenance };
}

/**
 * The whole V2 path for A's trigger and the wake: the factory above, then f4df98c3's binding with C's store ports (`store`, built by the
 * wake: env, owner port, policy revision) and the approved execution policy. Refusals of the factory are returned as missing ports.
 */
export function createCaseInvestigationToReplyPlan(input: CaseInvestigationV2Input & Readonly<{
  store: Pick<CaseReplyStoreDeps, "env" | "readTicketOwner"> & Partial<Pick<CaseReplyStoreDeps, "currentPolicyRevision" | "pilotProvenance">>;
  executionPolicy: CaseReplyPassageDeps["policy"];
  language?: CaseReplyPassageDeps["language"];
}>): CaseReplyPlanBinding | Readonly<{ ok: false; refusals: readonly string[] }> {
  const built = createCaseInvestigationV2Deps(input);
  if (!built.ok) return built;
  return bindCaseInvestigationToReplyPlan({ investigation: built.deps, provenance: built.provenance, policy: input.executionPolicy,
    store: { currentPolicyRevision: built.provenance.currentPolicyRevision, pilotProvenance: pilotProvenanceGate(built.provenance), ...input.store },
    ...(input.language ? { language: input.language } : {}) });
}
