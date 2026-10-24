import { createHash } from "node:crypto";
import { z } from "zod";
import { planSavIntake } from "./engine";
import { createSavIntakeHubspotReaders, type IntakeReadTrace } from "./hubspot-readers";
import { createSavIntakeSemanticReaders, type IntakeGeminiCall, type IntakeModelTrace } from "./model-readers";
import type { EngineInput, EnginePolicy, IntakePlan } from "./engine-types";

export const SAV_INTAKE_EVALUATION_REVISION = "sav-intake-read-only-evaluation-2026-10-20.v1";
const sha = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
const positive = z.number().int().positive().safe();
export const savIntakeEvaluationGrantSchema = z.object({
  corpusManifestSha256: z.string().regex(/^[a-f0-9]{64}$/), referenceManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  model: z.string().regex(/^gemini-[A-Za-z0-9._-]{1,100}$/),
  existingApprovalReference: z.string().min(1).max(200),
  // Verified residual budget from the existing admission system, not a new envelope.
  remainingNanoUsd: positive, maxReservedNanoUsdPerCall: positive,
  maxCases: positive.max(40), maxCallsPerCase: positive.max(6),
}).strict();
export type EvaluationGrant = z.infer<typeof savIntakeEvaluationGrantSchema>;
export type EvaluationReference = {
  classification?: string; contactId?: string | null; ticketId?: string | null;
  action?: string; sourceState: "current" | "historical"; qualifiedDimensions: ("classification" | "contact" | "ticket" | "action")[];
};
export type EvaluationCase = { caseId: string; clientGroup: string; input: EngineInput; policy: EnginePolicy; reference: EvaluationReference };
export type EvaluationRecord = { caseId: string; clientGroup: string; plan: IntakePlan; traces: IntakeModelTrace[]; reads: IntakeReadTrace[];
  dimensions: Partial<Record<"classification" | "contact" | "ticket" | "action", boolean>>; calls: number };
export function scoreSavIntakePlan(plan: IntakePlan, reference: EvaluationReference): EvaluationRecord["dimensions"] {
  const result: EvaluationRecord["dimensions"] = {}, d = plan.decision.disposition;
  const contact = d.kind === "ticket" ? d.target.contactId : null;
  const ticket = d.kind === "ticket" && d.target.operation !== "create" ? d.target.ticketId : null;
  const action = d.kind === "ticket" ? d.target.operation : d.kind;
  if (reference.qualifiedDimensions.includes("classification") && reference.classification !== undefined) result.classification = plan.decision.classification === reference.classification;
  if (reference.qualifiedDimensions.includes("contact") && reference.contactId !== undefined) result.contact = contact === reference.contactId;
  if (reference.qualifiedDimensions.includes("ticket") && reference.ticketId !== undefined) result.ticket = ticket === reference.ticketId;
  if (reference.qualifiedDimensions.includes("action") && reference.action !== undefined) result.action = action === reference.action;
  return result;
}

/** A single bounded development pass. Network has only the CRM read allowlist;
 * model is the existing trusted JSON capability. No DB, writer, route or file API.
 * Corpus, references, grant and output storage are owned by a trusted private
 * launcher. These hashes bind content, and do not authenticate that launcher. */
export async function evaluateSavIntakeReadOnly(options: {
  cases: EvaluationCase[]; corpusManifestSha256: string; referenceManifestSha256: string;
  configuredModel: string; grant: EvaluationGrant | null; network: typeof fetch; call: IntakeGeminiCall | null;
  withExistingAiBudget: <T>(work: () => Promise<T>) => Promise<T>;
  now?: () => Date;
}): Promise<{ revision: string; records: EvaluationRecord[]; stopReason: string | null;
  reservedNanoUsd: number; modelCalls: number; independentClientGroups: number; effects: "none" }> {
  const records: EvaluationRecord[] = []; let reservedNanoUsd = 0, modelCalls = 0;
  const finish = (stopReason: string | null) => ({ revision: SAV_INTAKE_EVALUATION_REVISION, records, stopReason, reservedNanoUsd, modelCalls,
    independentClientGroups: new Set(records.map(r => r.clientGroup)).size, effects: "none" as const });
  const parsed = savIntakeEvaluationGrantSchema.safeParse(options.grant);
  if (!parsed.success || !options.call) return finish("MODEL_ACCESS_OR_EXISTING_TOTAL_BUDGET_MISSING");
  const grant = parsed.data;
  if (grant.model !== options.configuredModel || grant.corpusManifestSha256 !== options.corpusManifestSha256
    || grant.referenceManifestSha256 !== options.referenceManifestSha256) return finish("CONFIGURATION_OR_REFERENCE_MISMATCH");
  if (!options.cases.length || options.cases.length > grant.maxCases || new Set(options.cases.map(c => c.caseId)).size !== options.cases.length
    || options.cases.some(c => !c.caseId || !c.clientGroup || c.reference.sourceState !== c.input.mode.replace("at_receipt", "historical"))) return finish("CORPUS_INVALID");
  // Bind the in-memory batch before the first read; the launcher separately binds
  // source exports to its manifest. No labels are learned from model outputs.
  const frozenBatchHash = sha(options.cases);
  for (const item of options.cases) {
    if (sha(options.cases) !== frozenBatchHash) return finish("CORPUS_CHANGED");
    if (records.length === 3 && records.some(r => Object.values(r.dimensions).includes(false) || r.traces.some(t => !t.accepted)
      || r.reads.some(read => read.status !== "complete") || !Object.keys(r.dimensions).length)) return finish("PILOT_REQUIRES_REVIEW");
    const traces: IntakeModelTrace[] = [], reads: IntakeReadTrace[] = []; let calls = 0;
    const guardedCall: IntakeGeminiCall = async request => {
      if (request.signal.aborted) throw Error("SAV_INTAKE_MODEL_CANCELLED");
      if (request.model !== grant.model || calls >= Math.min(3, grant.maxCallsPerCase)
        || reservedNanoUsd + grant.maxReservedNanoUsdPerCall > grant.remainingNanoUsd) throw Error("SAV_INTAKE_EVALUATION_BUDGET_EXHAUSTED");
      // Retain the full reservation even when the provider result is uncertain.
      reservedNanoUsd += grant.maxReservedNanoUsdPerCall; calls++; modelCalls++;
      return options.call!(request);
    };
    const semantics = createSavIntakeSemanticReaders({ model: grant.model, call: guardedCall, onTrace: trace => traces.push(trace),
      planCalls: async requests => {
        const maxCalls = Math.min(3, grant.maxCallsPerCase);
        if (requests.length < 1 || requests.length > maxCalls || calls + requests.length > maxCalls
          || reservedNanoUsd + requests.length * grant.maxReservedNanoUsdPerCall > grant.remainingNanoUsd
          || requests.some(request => request.signal.aborted || request.model !== grant.model || request.phase !== "ticket_matching"
            || request.allowRetry !== false || request.media?.length || request.body.generationConfig.maxOutputTokens !== 8192)) {
          throw Error("SAV_INTAKE_EVALUATION_BUDGET_EXHAUSTED");
        }
      } });
    const readers = createSavIntakeHubspotReaders({ network: options.network, now: options.now, onRead: trace => reads.push(trace) });
    const plan = await options.withExistingAiBudget(() => planSavIntake(item.input, { ...readers, ...semantics }, item.policy, { timeoutMs: 10_000 }, options.now ?? (() => new Date())));
    records.push({ caseId: item.caseId, clientGroup: item.clientGroup, plan, traces, reads, dimensions: scoreSavIntakePlan(plan, item.reference), calls });
    if (traces.some(t => t.errorCode === "SAV_INTAKE_EVALUATION_BUDGET_EXHAUSTED")) return finish("EXISTING_TOTAL_BUDGET_EXHAUSTED");
  }
  return finish(null);
}
