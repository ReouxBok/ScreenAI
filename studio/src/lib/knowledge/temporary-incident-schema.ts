import { z } from "zod";
import { SAV_CASE_REQUEST_FAMILIES, SAV_CASE_SENSITIVE_FAMILIES } from "@/lib/sav/cases/case-types";

/**
 * Temporary incident (SAV-79): a declared, bounded exception the SAV agent may use
 * while it applies. It is never a general rule, never grants an action, and never
 * claims a fix beyond the proven evidence level. Pure module: no DB, no prompt, no send.
 *
 * It is stored inside a canonical knowledge revision, so it goes through the same privacy
 * check as the rest of the document: no email, identifier or link is stored here. Approval and
 * authorship are those of the carrying revision (review state, reviewer, audit log).
 * Must not import ./contracts (contracts.ts embeds this schema).
 */
export const TEMPORARY_INCIDENT_MAX_DAYS = 30;

/** Ordered: each level implies the previous ones were established. */
export const TEMPORARY_FIX_LEVELS = ["none", "fix_announced", "deploy_proven", "client_verified"] as const;
export type TemporaryFixLevel = (typeof TEMPORARY_FIX_LEVELS)[number];

const text = z.string().trim().min(3).max(2_000);
const isoInstant = z.iso.datetime({ offset: true });

const fixSchema = z.object({
  level: z.enum(TEMPORARY_FIX_LEVELS),
  // A human-readable proof label (release name, check performed), not a link or an identifier.
  evidence: z.string().trim().max(500).default(""),
  establishedAt: isoInstant.optional(),
}).strict().superRefine((fix, ctx) => {
  if (fix.level !== "none" && (!fix.evidence || !fix.establishedAt)) ctx.addIssue({ code: "custom", message: "TEMPORARY_FIX_EVIDENCE_REQUIRED", path: ["evidence"] });
});

/** Structural contract stored in the canonical document (contracts.ts). */
export const temporaryIncidentDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().trim().regex(/^[a-z][a-z0-9-]{2,80}$/),
  revision: z.number().int().min(1),
  title: z.string().trim().min(3).max(200),
  scope: z.object({
    // Only existing case families; sensitive families stay human and cannot carry an incident reply.
    // The knowledge item is implicit: the incident belongs to the family revision that carries it.
    families: z.array(z.enum(SAV_CASE_REQUEST_FAMILIES)).min(1).max(5),
    productArea: z.string().trim().min(2).max(120),
  }).strict(),
  // Declared intent only. Applying it also requires the carrying revision to be approved by the SAV reviewer.
  status: z.enum(["active", "revoked"]),
  knownSince: isoInstant,
  validUntil: isoInstant,
  infoToCollect: z.array(z.string().trim().min(3).max(300)).max(5).default([]),
  approvedReply: text,
  fix: fixSchema,
  supersedes: z.string().trim().max(80).optional(),
  revocation: z.object({ at: isoInstant, reason: text }).strict().optional(),
  provenance: z.object({ source: z.string().trim().min(3).max(500), recordedAt: isoInstant }).strict(),
}).strict().superRefine((value, ctx) => {
  const start = Date.parse(value.knownSince); const end = Date.parse(value.validUntil);
  if (!(end > start)) ctx.addIssue({ code: "custom", message: "TEMPORARY_VALIDITY_INVALID", path: ["validUntil"] });
  if (end - start > TEMPORARY_INCIDENT_MAX_DAYS * 86_400_000) ctx.addIssue({ code: "custom", message: "TEMPORARY_VALIDITY_TOO_LONG", path: ["validUntil"] });
  if (value.scope.families.some((family) => (SAV_CASE_SENSITIVE_FAMILIES as readonly string[]).includes(family))) ctx.addIssue({ code: "custom", message: "TEMPORARY_SENSITIVE_FAMILY_STAYS_HUMAN", path: ["scope", "families"] });
  if (value.status === "revoked" && !value.revocation) ctx.addIssue({ code: "custom", message: "TEMPORARY_REVOCATION_REQUIRED", path: ["revocation"] });
  if (value.status !== "revoked" && value.revocation) ctx.addIssue({ code: "custom", message: "TEMPORARY_REVOCATION_UNEXPECTED", path: ["revocation"] });
  if (value.supersedes === value.id) ctx.addIssue({ code: "custom", message: "TEMPORARY_SUPERSEDES_SELF", path: ["supersedes"] });
  const claim = unprovenFixClaim(value.approvedReply, value.fix.level);
  if (claim) ctx.addIssue({ code: "custom", message: claim, path: ["approvedReply"] });
});
export type TemporaryIncident = z.infer<typeof temporaryIncidentDocumentSchema>;

// Unicode boundaries: `\b` treats accented letters as non-word characters.
const FIXED_WORDING = /(?<!\p{L})(corrig[ée]e?s?|r[ée]solue?s?|r[ée]par[ée]e?s?|d[ée]ploy[ée]e?s?|fonctionne (?:à nouveau|de nouveau)|r[ée]tabli[es]?)(?!\p{L})/iu;
const NEGATED = /(?<!\p{L})(?:pas encore|non encore|pas)\s+(?:\S+\s+){0,2}(?:corrig|r[ée]solu|r[ée]par|d[ée]ploy|r[ée]tabli)\p{L}*/giu;

/** The approved text may only claim what the evidence level proves. */
export function unprovenFixClaim(reply: string, level: TemporaryFixLevel): string | null {
  if (level === "deploy_proven" || level === "client_verified") return null;
  const stripped = reply.replace(NEGATED, "");
  return FIXED_WORDING.test(stripped) ? "TEMPORARY_FIX_CLAIM_UNPROVEN" : null;
}

/** Client-facing statement per evidence level: never stronger than the proof. */
export function fixStatement(level: TemporaryFixLevel) {
  switch (level) {
    case "none": return "Le problème est connu de l’équipe ; nous n’avons pas encore de correctif à annoncer.";
    case "fix_announced": return "Un correctif est prévu ; son déploiement n’est pas encore confirmé.";
    case "deploy_proven": return "Un correctif a été déployé ; merci de nous dire si le problème persiste de votre côté.";
    case "client_verified": return "Le correctif est déployé et a été vérifié.";
  }
}
