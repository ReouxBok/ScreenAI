import { SAV_INTAKE_OPERATIONAL_PROFILE, intakeOperationalTermValid } from "./budget-profile";
import { createHash } from "node:crypto";
import { z } from "zod";
import { SAV_INTAKE_MODEL_REVISION } from "./model-readers";
import { SAV_INTAKE_READERS_REVISION } from "./hubspot-readers";
import { SAV_MESSAGE_CONTEXT_REVISION } from "../message-context";
import type { EnginePolicy, IntakePlan } from "./engine-types";

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
  resourcesHash: z.string().regex(/^[a-f0-9]{64}$/), policyHash: z.string().regex(/^[a-f0-9]{64}$/), maxNanoUsd: z.number().int().min(1).max(3_000_000_000), maxCalls: z.number().int().min(1).max(300),
  budgetProfile: z.literal(SAV_INTAKE_OPERATIONAL_PROFILE).optional(), maxRollingNanoUsd: z.number().int().min(1).max(90_000_000_000).optional() }).strict().refine(p =>
    p.budgetProfile === SAV_INTAKE_OPERATIONAL_PROFILE ? p.maxRollingNanoUsd !== undefined : p.maxCalls <= 30 && p.maxRollingNanoUsd === undefined);
export type IntakeRuntimeConfig = z.infer<typeof savIntakeRuntimePins> & { mode: "observe"; policy: EnginePolicy; configHash: string; model: "gemini-3.6-flash" };
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
    return { ...p, mode: "observe", policy, model: "gemini-3.6-flash", configHash: intakeRuntimeHash({ ...p, revision: SAV_INTAKE_RUNTIME_REVISION, prompts: SAV_INTAKE_MODEL_REVISION, readers: SAV_INTAKE_READERS_REVISION, context: SAV_MESSAGE_CONTEXT_REVISION,
      otherRulesHash: intakeRuntimeHash(env.SAV_OTHER_OBSERVATION_RULES_JSON ?? null),
      accessBinding: intakeRuntimeHash({ model: env.SAV_GEMINI_API_KEY, crm: env.HUBSPOT_ACCESS_TOKEN }) }) };
  } catch { throw Error("SAV_INTAKE_RUNTIME_CONFIGURATION_REQUIRED"); }
}
export type IntakeRuntimeState = "pending" | "analysing" | "observed" | "waiting" | "uncertain" | "superseded";
export type IntakeRuntimePayload = {
  revision: typeof SAV_INTAKE_RUNTIME_REVISION;
  input?: unknown; plan?: IntakePlan;
  configuration?: { configHash: string; resourcesHash: string; policyHash: string; codeRevision: string; model: string };
  semantics?:import("./semantic-records").AcceptedIntakeSemantics;
  provenance?:unknown; traces?: unknown[]; reason?: string;
  effects: "not_connected";
};
export function assertSavIntakeObservation(plan: IntakePlan) {
  if (plan.effects !== "not_connected" || plan.steps.some(step => step.status !== "not_dispatched")) throw Error("SAV_INTAKE_RUNTIME_EFFECT_REJECTED");
}
