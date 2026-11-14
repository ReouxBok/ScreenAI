import { markSavCaseCallDispatched, releaseSavCaseCall, reserveSavCaseCall, settleSavCaseCall } from "./case-calls";
import { caseBudgetedKnowledge, type CaseEmbeddingSpendPort, type CaseEmbeddingTransport, type CaseKnowledgeVectorSearch } from "./investigation-budgeted-retrieval";
import { caseCallLedgerAdapter, type CaseCallLedgerAdapterOptions, type CaseCallLedgerPort } from "./investigation-call-ledger";
import { runCaseInvestigation, SAV_CASE_INVESTIGATION_MAX_CALLS, type CaseInvestigationPorts, type CaseInvestigationReport } from "./investigation-runner";
import { caseInvestigationStorePorts, type CaseInvestigationStoreDeps } from "./investigation-store-ports";

/*
 * SAV-7/SAV-11: the one assembled V2 investigation path, local and OFF. A confirmed V1 mail relayed into pole A's case
 * store → B's runner on A's store ports → the budgeted per-request knowledge search (embedding paid only through the
 * ledger and the spend port) → the model through the same ledger and ROOT's money gate → the decision stored as the
 * claim's observation. Nothing calls it in production; every port that reaches outside the database (ticket owner,
 * qualification, vector index, embedding transport, spend, money, model) is injected, and a missing one stops the run
 * before any read or write. No transport, price, budget, cap, role or owner is defined here.
 */

/** Pole A's call ledger (`case-calls.ts`), as the ledger port of both the model and the embedding calls. */
export const caseCallLedgerOnStore: CaseCallLedgerPort = {
  reserve: input => reserveSavCaseCall(input),
  markDispatched: input => markSavCaseCallDispatched(input),
  settle: input => settleSavCaseCall(input),
  release: input => releaseSavCaseCall(input),
};

export type CaseInvestigationRuntimeDeps = {
  /** Only `observe` runs; anything else is OFF. */
  mode: "observe" | "off";
  holder: string;
  scope: { locale: string; audience: "support" | "lead" };
  now: () => Date;
  /** Ledger lease of a call, and the longest an embedding call may take before it is held uncertain. */
  leaseSeconds: number;
  ttlSeconds?: number;
  pauseState: CaseInvestigationPorts["pauseState"];
  callSignal?: CaseInvestigationPorts["callSignal"];
  readTicketOwner?: CaseInvestigationPorts["readTicketOwner"];
  /** Pilot ACCÈS scope of sources (approved policy datum). Absent: closed, so no `access` case is searched or answered. */
  accessScope?: CaseInvestigationPorts["accessScope"];
  temporaryIncidents?: CaseInvestigationPorts["temporaryIncidents"];
  admissionPolicyRevision?: CaseInvestigationStoreDeps["admissionPolicyRevision"];
  qualify?: CaseInvestigationStoreDeps["qualify"];
  customerTexts?: CaseInvestigationPorts["customerTexts"];
  /** SAV-92: optional; absent, the model sees no customer context and the search uses V1's subjects only (as before). */
  customerContext?: CaseInvestigationPorts["customerContext"];
  revisions?: CaseInvestigationPorts["revisions"];
  ledger?: CaseCallLedgerPort;
  knowledge: { vectors?: CaseKnowledgeVectorSearch; embed?: CaseEmbeddingTransport; spend?: CaseEmbeddingSpendPort };
  model: { preflight?: CaseCallLedgerAdapterOptions["preflight"]; provider?: CaseCallLedgerAdapterOptions["provider"]; money?: CaseCallLedgerAdapterOptions["money"]; releaseMoney?: CaseCallLedgerAdapterOptions["releaseMoney"] };
};

export type CaseInvestigationRuntimeReport = CaseInvestigationReport | { status: "not_wired"; caseId: string; missing: string[]; modelCalls: 0 };

export async function runCaseInvestigationRuntime(caseId: string, deps: CaseInvestigationRuntimeDeps): Promise<CaseInvestigationRuntimeReport> {
  if (deps.mode !== "observe") return { status: "off", caseId, modelCalls: 0 };
  const required = {
    readTicketOwner: deps.readTicketOwner, admissionPolicyRevision: deps.admissionPolicyRevision, qualify: deps.qualify, customerTexts: deps.customerTexts,
    revisions: deps.revisions, ledger: deps.ledger, "knowledge.vectors": deps.knowledge.vectors, "knowledge.embed": deps.knowledge.embed,
    "knowledge.spend": deps.knowledge.spend, "model.provider": deps.model.provider, "model.money": deps.model.money,
  };
  const missing = Object.entries(required).filter(([, port]) => port === undefined).map(([name]) => name);
  if (missing.length) return { status: "not_wired", caseId, missing, modelCalls: 0 };
  const ledger = deps.ledger!;
  let readCase: CaseInvestigationPorts["readCase"] | null = null;
  const ports = caseInvestigationStorePorts({
    holder: deps.holder, scope: deps.scope, now: deps.now, pauseState: deps.pauseState, readTicketOwner: deps.readTicketOwner!,
    ...(deps.ttlSeconds === undefined ? {} : { ttlSeconds: deps.ttlSeconds }), ...(deps.callSignal === undefined ? {} : { callSignal: deps.callSignal }),
    admissionPolicyRevision: deps.admissionPolicyRevision!, qualify: deps.qualify!, customerTexts: deps.customerTexts!, revisions: deps.revisions!,
    knowledge: (snapshot, context) => caseBudgetedKnowledge({
      holder: deps.holder, leaseSeconds: deps.leaseSeconds, scope: deps.scope, now: deps.now,
      vectors: deps.knowledge.vectors!, embed: deps.knowledge.embed!, spend: deps.knowledge.spend!, ledger,
      pauseState: deps.pauseState, readTicketOwner: deps.readTicketOwner!, readCase: id => readCase!(id),
    })(snapshot, context),
    callModel: caseCallLedgerAdapter({ ledger, ...(deps.model.preflight ? { preflight: deps.model.preflight } : {}), money: deps.model.money!, ...(deps.model.releaseMoney ? { releaseMoney: deps.model.releaseMoney } : {}), provider: deps.model.provider!, holder: deps.holder,
      leaseSeconds: deps.leaseSeconds, maxPerSubject: SAV_CASE_INVESTIGATION_MAX_CALLS }),
  });
  // The freshness check of the budgeted search reads the case the same way the runner does.
  readCase = ports.readCase;
  const readExact = deps.knowledge.vectors!.readExact?.bind(deps.knowledge.vectors);
  return runCaseInvestigation(caseId, "observe", { ...ports, accessScope: deps.accessScope ?? (async () => null),
    ...(deps.temporaryIncidents ? { temporaryIncidents: deps.temporaryIncidents } : {}),
    ...(deps.customerContext ? { customerContext: deps.customerContext } : {}),
    // Scope-first knowledge (11/11): the exact-version read of the block's scope sources, and the transport's own preflight to fit the input.
    ...(readExact ? { readScopeCards: readExact } : {}), ...(deps.model.preflight ? { preflight: deps.model.preflight } : {}) });
}
