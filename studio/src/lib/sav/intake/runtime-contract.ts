import { SAV_INTAKE_BUDGET_BOUNDS, SAV_INTAKE_OPERATIONAL_PROFILE, intakeOperationalTermValid } from "./budget-profile";
import { createHash } from "node:crypto";
import { z } from "zod";
import { SAV_INTAKE_MODEL_REVISION } from "./model-readers";
import { SAV_INTAKE_READERS_REVISION } from "./hubspot-readers";
import { SAV_MESSAGE_CONTEXT_REVISION } from "../message-context";
import type { EnginePolicy, IntakePlan } from "./engine-types";
import { intakeReadRecoveryPolicySchema } from "./read-recovery";
import { SAV_ATTACHMENT_PDF_REVISION } from "../attachment-contract";

export const SAV_INTAKE_RUNTIME_REVISION = "sav-intake-runtime-2026-10-21.v1";
export const intakeRuntimeHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const resource = z.object({ resourceId: z.string().min(1).max(200), revisionId: z.string().min(1).max(200), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const policySchema = z.object({
  relationRevision: z.string().min(1).max(200),
  admittedRelations: z.array(z.object({ typeId: z.number().int().nonnegative(), category: z.enum(["HUBSPOT_DEFINED", "USER_DEFINED"]) }).strict()).max(20),
  resources: z.object({ identification: resource.optional(), registrationNotFound: resource.optional(),
    multiTicketWarning: resource.extend({ text: z.string().min(1).max(4000) }).optional(),
    partnership: resource.optional(), commercial: resource.optional(), investor: resource.optional() }).strict(),
}).strict();
export const savIntakeRuntimePins = z.object({ mailboxId: z.uuid(), createdAfter: z.iso.datetime(), receivedAfter: z.iso.datetime(), expiresAt: z.iso.datetime(), codeRevision: z.string().regex(/^[a-f0-9]{40}$/),
  resourcesHash: z.string().regex(/^[a-f0-9]{64}$/), policyHash: z.string().regex(/^[a-f0-9]{64}$/), maxNanoUsd: z.number().int().min(1).max(SAV_INTAKE_BUDGET_BOUNDS.operational.maxNanoUsd), maxCalls: z.number().int().min(1).max(SAV_INTAKE_BUDGET_BOUNDS.operational.maxCalls),
  readRecovery: intakeReadRecoveryPolicySchema.optional(),
  budgetProfile: z.literal(SAV_INTAKE_OPERATIONAL_PROFILE).optional(), maxRollingNanoUsd: z.number().int().min(1).max(SAV_INTAKE_BUDGET_BOUNDS.operational.maxRollingNanoUsd).optional() }).strict().refine(p =>
    p.budgetProfile === SAV_INTAKE_OPERATIONAL_PROFILE ? p.maxRollingNanoUsd !== undefined
      : p.maxCalls <= SAV_INTAKE_BUDGET_BOUNDS.qualification.maxCalls && p.maxNanoUsd <= SAV_INTAKE_BUDGET_BOUNDS.qualification.maxNanoUsd && p.maxRollingNanoUsd === undefined);
export type IntakeRuntimeConfig = z.infer<typeof savIntakeRuntimePins> & { mode: "observe"; policy: EnginePolicy; configHash: string; model: "gemini-3.6-flash";
  /** Reader pipeline for NEW runs only; frozen in each run at creation and deliberately outside configHash. */
  pipeline?: SavIntakePipeline;
  /** SAV-43: PDF attachments read by the visual call. Off by default and inside configHash. */
  pdfReading?: boolean };
export const SAV_INTAKE_PIPELINES = ["current", "simple"] as const;
export type SavIntakePipeline = typeof SAV_INTAKE_PIPELINES[number];
/** Absent means the current multi-call readers; any other value is a configuration error, never a silent default. */
export function savIntakePipeline(env: Record<string, string | undefined>): SavIntakePipeline {
  const value = env.SAV_INTAKE_PIPELINE ?? "current";
  if (!(SAV_INTAKE_PIPELINES as readonly string[]).includes(value)) throw Error("SAV_INTAKE_RUNTIME_CONFIGURATION_REQUIRED");
  return value as SavIntakePipeline;
}
/** Absent or "off" keeps PDFs unread; only "on" enables them. Anything else is a configuration error. */
export function savIntakePdfReading(env: Record<string, string | undefined>) {
  const value = env.SAV_INTAKE_PDF_READING ?? "off";
  if (value !== "on" && value !== "off") throw Error("SAV_INTAKE_RUNTIME_CONFIGURATION_REQUIRED");
  return value === "on";
}
/** Pure, explicit binding used also to verify a previous deployment receipt.
 * A historical hash never grants permission to run a model under a new build. */
export function intakeRuntimeConfigurationHash(p: z.infer<typeof savIntakeRuntimePins>, env: Record<string, string | undefined>, prompts = SAV_INTAKE_MODEL_REVISION) {
  p = savIntakeRuntimePins.parse(p);
  return intakeRuntimeHash({ ...p, revision: SAV_INTAKE_RUNTIME_REVISION, prompts, readers: SAV_INTAKE_READERS_REVISION, context: SAV_MESSAGE_CONTEXT_REVISION,
    otherRulesHash: intakeRuntimeHash(env.SAV_OTHER_OBSERVATION_RULES_JSON ?? null),
    otherRoutingHash: intakeRuntimeHash(env.SAV_INTAKE_OTHER_RULES_JSON ?? null),
    ...(env.SAV_INTAKE_CRM_ACK_TEMPLATES_JSON ? {crmAcknowledgementsHash:intakeRuntimeHash(env.SAV_INTAKE_CRM_ACK_TEMPLATES_JSON)} : {}),
    // Switching PDF reading on or off is a new launch configuration; off keeps the previous hash.
    ...(savIntakePdfReading(env) ? { pdfReading: SAV_ATTACHMENT_PDF_REVISION } : {}),
    accessBinding: intakeRuntimeHash({ model: env.SAV_GEMINI_API_KEY, crm: env.HUBSPOT_ACCESS_TOKEN }) });
}
/** No permissive defaults, campaign resets or hidden reuse of another budget. */
export function savIntakeRuntimeConfig(env: Record<string, string | undefined> = process.env, now = new Date()): IntakeRuntimeConfig | null {
  if (env.SAV_INTAKE_RUNTIME_MODE !== "observe") return null;
  try {
    const p = savIntakeRuntimePins.parse(JSON.parse(env.SAV_INTAKE_RUNTIME_CONFIG ?? ""));
    if ((env.SAV_INTAKE_RUNTIME_POLICY?.length ?? 0) > 32_000 || (env.SAV_INTAKE_RUNTIME_RESOURCES?.length ?? 0) > 64_000) throw Error();
    const rawPolicy = JSON.parse(env.SAV_INTAKE_RUNTIME_POLICY ?? ""), policy = policySchema.parse(rawPolicy);
    const catalogue = z.array(z.object({ resource: resource, text: z.string().min(1).max(8000), approvalId: z.string().min(1).max(200),
      approvedBy: z.string().min(1).max(200), approvedAt: z.iso.datetime(), status: z.literal("approved") }).strict()).max(10).parse(JSON.parse(env.SAV_INTAKE_RUNTIME_RESOURCES ?? ""));
    if (intakeRuntimeHash(catalogue) !== p.resourcesHash || catalogue.some(r => createHash("sha256").update(r.text).digest("hex") !== r.resource.sha256 || Date.parse(r.approvedAt) > now.getTime())) throw Error();
    for (const [kind, reference] of Object.entries(policy.resources)) {
      if (!reference) continue;
      const approved = catalogue.find(entry => JSON.stringify(entry.resource) === JSON.stringify({resourceId:reference.resourceId,revisionId:reference.revisionId,sha256:reference.sha256}));
      if (!approved || kind === "multiTicketWarning" && approved.text !== policy.resources.multiTicketWarning?.text) throw Error();
    }
    if (intakeRuntimeHash(rawPolicy) !== p.policyHash || (env.VERCEL_GIT_COMMIT_SHA ?? env.SAV_CODE_REVISION) !== p.codeRevision || env.SAV_AI_MODEL !== "gemini-3.6-flash"
      || !Number.isFinite(now.getTime()) || Date.parse(p.createdAfter) > now.getTime() || (p.budgetProfile !== SAV_INTAKE_OPERATIONAL_PROFILE && now.getTime() - Date.parse(p.createdAfter) > 86_400_000) || Date.parse(p.receivedAfter) >= Date.parse(p.expiresAt) || now.getTime() >= Date.parse(p.expiresAt)
      || (p.budgetProfile === SAV_INTAKE_OPERATIONAL_PROFILE ? !intakeOperationalTermValid(p.expiresAt,now) : Date.parse(p.expiresAt) - now.getTime() > 86_400_000) || !env.SAV_GEMINI_API_KEY || !env.HUBSPOT_ACCESS_TOKEN
      || (env.SAV_ENCRYPTION_KEY_V1?.length ?? 0) < 32) throw Error();
    const warning = policy.resources.multiTicketWarning;
    if (warning && createHash("sha256").update(warning.text).digest("hex") !== warning.sha256) throw Error();
    return { ...p, mode: "observe", policy, model: "gemini-3.6-flash", configHash: intakeRuntimeConfigurationHash(p, env), pipeline: savIntakePipeline(env),
      ...(savIntakePdfReading(env) ? { pdfReading: true } : {}) };
  } catch { throw Error("SAV_INTAKE_RUNTIME_CONFIGURATION_REQUIRED"); }
}
export type IntakeRuntimeState = "pending" | "analysing" | "observed" | "waiting" | "uncertain" | "superseded";
export type IntakeRuntimePayload = {
  revision: typeof SAV_INTAKE_RUNTIME_REVISION;
  input?: unknown; plan?: IntakePlan;
  other?: import("./other-routing").IntakeOtherQualification;
  attachments?: import("./attachments").IntakeAttachmentState;
  configuration?: { configHash: string; resourcesHash: string; policyHash: string; codeRevision: string; model: string };
  semantics?:import("./semantic-records").AcceptedIntakeSemantics;
  readRecovery?: import("./read-recovery").IntakeReadRecovery;
  reanalysisParent?: { runId: string; payloadHash: string; sourceHash: string; messageSourceHash: string };
  provenance?:unknown; traces?: unknown[]; reason?: string;
  /** Fixed when the run is created; analysis, repairs and resumes keep it. Absent: current. */
  pipeline?: SavIntakePipeline;
  effects: "not_connected";
};
export function assertSavIntakeObservation(plan: IntakePlan) {
  if (plan.effects !== "not_connected" || plan.steps.some(step => step.status !== "not_dispatched")) throw Error("SAV_INTAKE_RUNTIME_EFFECT_REJECTED");
}
