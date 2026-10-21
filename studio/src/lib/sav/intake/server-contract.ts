import { createHash } from "node:crypto";
import { z } from "zod";
import { intakeMessageSchema, intakeContactSchema, intakeAssociationSchema, intakeTicketSchema, intakeHistorySchema } from "./engine-types";
import { savIntakePrivateResourceSchema } from "./contract";

export const EVALUATION_ACTION = "sav_intake_evaluation_v1";
export const EVALUATION_CALL = "sav_intake_evaluation_call_v1";
export const EVALUATION_CAP = 3_000_000_000; // nanoUSD, entire pilot, never a daily reset
export const EVALUATION_MAX_CALLS = 9;
export const EVALUATION_MAX_BYTES = 1_000_000;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^\d{1,30}$/);
const observed = z.iso.datetime({ offset: true });
const result = <T extends z.ZodType>(data: T) => z.object({ status: z.enum(["complete", "partial", "failed"]), data, observedAt: observed, reconstructedAsOf: observed.optional() }).strict();
const resource = savIntakePrivateResourceSchema;
export const evaluationCaseSchema = z.object({
  caseId: z.string().regex(/^[A-Za-z0-9-]{1,80}$/),
  input: z.object({ message: intakeMessageSchema, latestInboundMessageId: z.uuid(), conversation: result(z.array(intakeMessageSchema).max(50)), now: observed,
    mode: z.enum(["current", "at_receipt"]), identificationAttemptId: z.string().min(1).max(100),
    previousIdentification: z.object({ messageId: z.uuid(), address: z.email(), state: z.enum(["dispatched", "uncertain", "confirmed"]) }).strict().optional() }).strict(),
  policy: z.object({ relationRevision: z.string().min(1).max(150), admittedRelations: z.array(z.object({ typeId: z.number().int().nonnegative(), category: z.enum(["HUBSPOT_DEFINED", "USER_DEFINED"]) }).strict()).max(20),
    resources: z.object({ identification: resource.optional(), registrationNotFound: resource.optional(), multiTicketWarning: resource.extend({ text: z.string().max(2000) }).optional(), partnership: resource.optional(), commercial: resource.optional(), investor: resource.optional() }).strict(),
    qualifiedOther: z.object({ resource, evidenceSource: z.enum(["private_rule", "human_override"]) }).strict().optional(), manualSupportOverride: resource.optional() }).strict(),
  snapshots: z.object({
    lookups: z.record(z.email(), result(z.array(intakeContactSchema).max(10))),
    contacts: z.record(id, result(intakeContactSchema)),
    associations: z.record(id, result(z.array(intakeAssociationSchema).max(100))),
    tickets: z.record(id, result(z.array(intakeTicketSchema).max(20))),
    histories: z.record(id, result(intakeHistorySchema)),
  }).strict(),
}).strict();
export const evaluationBatchSchema = z.object({ version: z.literal(1), campaignId: z.string().regex(/^[a-z0-9-]{1,100}$/), cases: z.array(evaluationCaseSchema).length(3) }).strict()
  .refine(batch => new Set(batch.cases.map(c => c.caseId)).size === 3 && new Set(batch.cases.map(c => c.input.message.id)).size === 3, "Three distinct cases required");
export type EvaluationBatch = z.infer<typeof evaluationBatchSchema>;
export type ServerEvaluationConfig = { campaignId: string; manifestHash: string; codeRevision: string; origin: string; expiresAt: string; model: "gemini-3.6-flash" };
export function evaluationHash(value: string) { return createHash("sha256").update(value, "utf8").digest("hex"); }
export function evaluationConfig(env: Record<string, string | undefined>, now = new Date()): ServerEvaluationConfig {
  if (env.SAV_INTAKE_EVAL_ENABLED !== "1" || env.VERCEL_ENV !== "production") throw Error("SAV_EVAL_DISABLED");
  const parsed = z.object({ campaignId: z.string().regex(/^[a-z0-9-]{1,100}$/), manifestHash: digest, codeRevision: z.string().regex(/^[a-f0-9]{40}$/), origin: z.url(), expiresAt: observed, model: z.literal("gemini-3.6-flash") }).strict().parse({
    campaignId: env.SAV_INTAKE_EVAL_CAMPAIGN_ID, manifestHash: env.SAV_INTAKE_EVAL_MANIFEST_SHA256, codeRevision: env.SAV_INTAKE_EVAL_CODE_SHA,
    origin: env.SAV_INTAKE_EVAL_ORIGIN, expiresAt: env.SAV_INTAKE_EVAL_EXPIRES_AT, model: env.SAV_AI_MODEL,
  });
  const url = new URL(parsed.origin), expires = Date.parse(parsed.expiresAt);
  if (url.protocol !== "https:" || url.origin !== parsed.origin || env.VERCEL_GIT_COMMIT_SHA !== parsed.codeRevision
    || !Number.isFinite(now.getTime()) || expires <= now.getTime() || expires - now.getTime() > 86_400_000) throw Error("SAV_EVAL_CONFIG_REJECTED");
  return parsed;
}
export function assertEvaluationOrigin(request: Request, config: ServerEvaluationConfig) {
  const origin = request.headers.get("origin");
  const sameSiteRead = request.method === "GET" && origin === null && request.headers.get("sec-fetch-site") === "same-origin";
  if (new URL(request.url).origin !== config.origin || (!sameSiteRead && origin !== config.origin)
    || ![null, "same-origin", "none"].includes(request.headers.get("sec-fetch-site"))) throw Error("SAV_EVAL_ORIGIN_REJECTED");
}
/** Bound allocation before JSON parsing; Content-Length alone is not trusted. */
export async function readEvaluationBody(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json" || request.headers.has("content-encoding")) throw Error("SAV_EVAL_BODY_REJECTED");
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > EVALUATION_MAX_BYTES)) throw Error("SAV_EVAL_BODY_REJECTED");
  const reader = request.body?.getReader();
  if (!reader) throw Error("SAV_EVAL_BODY_REJECTED");
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let bytes = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength;
      if (bytes > EVALUATION_MAX_BYTES) throw Error("SAV_EVAL_BODY_REJECTED"); chunks.push(next.value); }
    if (signal.aborted) throw Error("SAV_EVAL_BODY_REJECTED");
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
  } finally { signal.removeEventListener("abort", cancel); await reader.cancel().catch(() => {}); }
}
