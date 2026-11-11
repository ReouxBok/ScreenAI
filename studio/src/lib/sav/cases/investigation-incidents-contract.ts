import { createHash } from "node:crypto";
import { z } from "zod";
import { SAV_CASE_REQUEST_FAMILIES } from "./case-types";

export const INCIDENT_RUNTIME_REVISION = "sav-temporary-context.v1";
export const INCIDENT_RUNTIME_LIMIT = 18;
export const incidentBindingSchema = z.object({ requestId: z.string().min(1).max(200), family: z.enum(SAV_CASE_REQUEST_FAMILIES),
  knowledgeId: z.uuid(), contentVersionId: z.uuid() }).strict();
export type IncidentBinding = z.infer<typeof incidentBindingSchema>;
const proof = z.object({ requestId: z.string().min(1).max(200), knowledgeId: z.uuid(), contentVersionId: z.uuid(), familyId: z.uuid(),
  canonicalRevisionId: z.uuid(), canonicalRevision: z.number().int().positive(), canonicalHash: z.string().min(1).max(128),
  approvalHash: z.string().regex(/^[a-f0-9]{64}$/), incidentId: z.string().min(3).max(81), incidentRevision: z.number().int().positive(),
  incidentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const entry = z.object({ proof, title: z.string().max(200), productArea: z.string().max(120), reply: z.string().max(2000),
  fixLevel: z.enum(["none", "fix_announced", "deploy_proven", "client_verified"]), fixStatement: z.string().max(500),
  infoToCollect: z.array(z.string().max(300)).max(5), validUntil: z.iso.datetime({ offset: true }), grantsActions: z.literal(false) }).strict();
export const incidentContextSchema = z.object({ revision: z.literal(INCIDENT_RUNTIME_REVISION), bindings: z.array(incidentBindingSchema).max(INCIDENT_RUNTIME_LIMIT),
  entries: z.array(entry).max(INCIDENT_RUNTIME_LIMIT), scope: z.enum(["bound", "scope_missing", "not_applicable"]),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type IncidentContext = z.infer<typeof incidentContextSchema>;
export type IncidentRead = { ok: true; context: IncidentContext } | { ok: false; problem: "invalid" | "conflict" | "scope_limit" | "read_failed" };
export type IncidentReader = (bindings: IncidentBinding[], now: Date) => Promise<IncidentRead>;
export const incidentHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function incidentContext(bindings: IncidentBinding[], entries: IncidentContext["entries"], scope: IncidentContext["scope"]): IncidentContext {
  const content = { revision: INCIDENT_RUNTIME_REVISION, bindings, entries, scope };
  return incidentContextSchema.parse({ ...content, fingerprint: incidentHash(content) });
}
