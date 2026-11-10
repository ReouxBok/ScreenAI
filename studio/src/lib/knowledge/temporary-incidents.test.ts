import { describe, expect, it } from "vitest";
import { fixStatement, isTemporaryIncidentApproved, type TemporaryIncidentReview, revokeTemporaryIncident, selectTemporaryIncident, temporaryIncidentSchema, unprovenFixClaim } from "./temporary-incidents";

// Synthetic example only (SYN routine), no client corpus, no identity stored in the incident.
const base = {
  schemaVersion: 1, id: "syn-routine-delay", revision: 1, title: "SYN routine planifiée en retard",
  scope: { families: ["usage"], productArea: "Routines" },
  status: "active", knownSince: "2026-11-10T08:00:00Z", validUntil: "2026-11-12T08:00:00Z",
  infoToCollect: ["Nom de la routine", "Heure prévue"],
  approvedReply: "Nous constatons un retard ponctuel sur certaines routines planifiées. L’équipe suit le sujet.",
  fix: { level: "none", evidence: "" },
  provenance: { source: "Déclaration interne SYN", recordedAt: "2026-11-10T08:05:00Z" },
};
const reviewed: TemporaryIncidentReview = { approved: true, reviewState: "approved", reviewedBy: "contact@limova.ai" };
const pending: TemporaryIncidentReview = { approved: false, reviewState: "pending", reviewedBy: null };
const record = (incident: unknown, review: TemporaryIncidentReview = reviewed) => ({ incident, review });
const at = (iso: string) => new Date(iso);
const ctx = { family: "usage", productArea: "routines", now: at("2026-11-11T10:00:00Z") };

describe("temporary incident contract", () => {
  it("applies one approved, in-scope, unexpired incident without granting any action", () => {
    const decision = selectTemporaryIncident([record(base)], ctx);
    expect(decision).toMatchObject({ kind: "apply", incidentId: "syn-routine-delay", revision: 1, grantsActions: false, infoToCollect: ["Nom de la routine", "Heure prévue"] });
    expect(decision.kind === "apply" && decision.fixStatement).toBe(fixStatement("none"));
  });

  it("does not become a general rule: other family or area does not match", () => {
    expect(selectTemporaryIncident([record(base)], { ...ctx, family: "integration" })).toEqual({ kind: "none", reason: "no_match" });
    expect(selectTemporaryIncident([record(base)], { ...ctx, productArea: "Téléphonie" })).toEqual({ kind: "none", reason: "no_match" });
  });

  it("real expiry closes the exception and base knowledge resumes; not yet known is not applied", () => {
    expect(selectTemporaryIncident([record(base)], { ...ctx, now: at("2026-11-12T08:00:00Z") })).toEqual({ kind: "none", reason: "expired" });
    expect(selectTemporaryIncident([record(base)], { ...ctx, now: at("2026-11-10T07:59:59Z") })).toEqual({ kind: "none", reason: "expired" });
  });

  it("is applied only when its carrying revision is approved by the SAV reviewer", () => {
    expect(selectTemporaryIncident([record(base, pending)], ctx)).toEqual({ kind: "none", reason: "not_approved" });
    expect(isTemporaryIncidentApproved({ approved: true, reviewState: "approved", reviewedBy: "someone@example.invalid" })).toBe(false);
    expect(isTemporaryIncidentApproved({ approved: false, reviewState: "approved", reviewedBy: "ugo@limova.ai" })).toBe(false);
    expect(isTemporaryIncidentApproved({ approved: true, reviewState: "pending", reviewedBy: "ugo@limova.ai" })).toBe(false);
    expect(isTemporaryIncidentApproved({ approved: true, reviewState: "approved", reviewedBy: "ugo@limova.ai" })).toBe(true);
  });

  it("keeps the approved incident while a newer revision or revocation is still pending review", () => {
    const newer = { ...base, revision: 2, title: "SYN proposition non approuvée" };
    const revoked = { ...newer, status: "revoked", revocation: { at: "2026-11-11T09:00:00Z", reason: "Proposition SYN de clôture" } };
    for (const draft of [newer, revoked, { ...newer, revision: 1 }, { ...revoked, revision: 1 }]) {
      expect(selectTemporaryIncident([record(base), record(draft, pending)], ctx)).toMatchObject({ kind: "apply", revision: 1, grantsActions: false });
      expect(selectTemporaryIncident([record(draft, pending), record(base)], ctx)).toMatchObject({ kind: "apply", revision: 1, grantsActions: false });
    }
    expect(selectTemporaryIncident([record(base), record(revoked)], ctx)).toEqual({ kind: "none", reason: "revoked" });
    expect(selectTemporaryIncident([record(revoked, pending)], ctx)).toEqual({ kind: "none", reason: "not_approved" });
    expect(selectTemporaryIncident([record(base), record({ ...base, title: "SYN contenu contradictoire approuvé" })], ctx))
      .toMatchObject({ kind: "invalid", route: "human", errors: ["TEMPORARY_APPROVED_REVISION_CONFLICT"] });
  });

  it("bounds validity, keeps sensitive families human and stores no identity", () => {
    expect(temporaryIncidentSchema.safeParse({ ...base, validUntil: "2026-12-31T00:00:00Z" }).error?.issues[0].message).toBe("TEMPORARY_VALIDITY_TOO_LONG");
    expect(temporaryIncidentSchema.safeParse({ ...base, validUntil: base.knownSince }).error?.issues[0].message).toBe("TEMPORARY_VALIDITY_INVALID");
    expect(temporaryIncidentSchema.safeParse({ ...base, scope: { ...base.scope, families: ["finance"] } }).error?.issues[0].message).toBe("TEMPORARY_SENSITIVE_FAMILY_STAYS_HUMAN");
    expect(temporaryIncidentSchema.safeParse({ ...base, scope: { ...base.scope, families: ["marketing"] } }).success).toBe(false);
    expect(temporaryIncidentSchema.safeParse({ ...base, approval: { by: "contact@limova.ai", at: base.knownSince } }).success).toBe(false);
    expect(temporaryIncidentSchema.safeParse({ ...base, scope: { ...base.scope, knowledgeItemIds: ["0b9a7d36-6c1a-4f0e-9a43-6a1b0b8d2e11"] } }).success).toBe(false);
  });

  it("cannot carry actions, rights or routine operations (strict schema)", () => {
    expect(temporaryIncidentSchema.safeParse({ ...base, actions: ["routine_restart"] }).success).toBe(false);
    expect(temporaryIncidentSchema.safeParse({ ...base, scope: { ...base.scope, grants: ["refund"] } }).success).toBe(false);
  });

  it("never claims a fix beyond the proven evidence level", () => {
    expect(unprovenFixClaim("Le problème est corrigé.", "none")).toBe("TEMPORARY_FIX_CLAIM_UNPROVEN");
    expect(unprovenFixClaim("Le correctif a été déployé.", "fix_announced")).toBe("TEMPORARY_FIX_CLAIM_UNPROVEN");
    expect(unprovenFixClaim("Ce n’est pas encore corrigé.", "none")).toBeNull();
    expect(unprovenFixClaim("Le problème est corrigé.", "deploy_proven")).toBeNull();
    expect(temporaryIncidentSchema.safeParse({ ...base, approvedReply: "Tout est résolu depuis ce matin." }).error?.issues[0].message).toBe("TEMPORARY_FIX_CLAIM_UNPROVEN");
    expect(temporaryIncidentSchema.safeParse({ ...base, fix: { level: "deploy_proven", evidence: "" } }).error?.issues[0].message).toBe("TEMPORARY_FIX_EVIDENCE_REQUIRED");
    const proven = { ...base, approvedReply: "Le correctif est déployé.", fix: { level: "deploy_proven", evidence: "Version SYN 1 vérifiée", establishedAt: "2026-11-11T09:00:00Z" } };
    const decision = selectTemporaryIncident([record(proven)], ctx);
    expect(decision.kind === "apply" && decision.fixStatement).toBe(fixStatement("deploy_proven"));
    expect(fixStatement("fix_announced")).not.toMatch(/a été déployé/);
  });

  it("overlapping live incidents are ambiguous and routed to a human", () => {
    const other = { ...base, id: "syn-routine-other" };
    expect(selectTemporaryIncident([record(base), record(other)], ctx)).toEqual({ kind: "ambiguous", incidentIds: ["syn-routine-delay", "syn-routine-other"], route: "human" });
  });

  it("an invalid record is never silently ignored", () => {
    expect(selectTemporaryIncident([record(base), record({ ...base, id: "syn-bad", validUntil: "not-a-date" })], ctx).kind).toBe("invalid");
  });

  it("supersedes and revocation keep history and use the latest incident revision", () => {
    const next = { ...base, id: "syn-routine-delay-v2", supersedes: "syn-routine-delay", approvedReply: "Le retard persiste sur certaines routines ; l’équipe suit le sujet." };
    expect(selectTemporaryIncident([record(base), record(next)], ctx)).toMatchObject({ kind: "apply", incidentId: "syn-routine-delay-v2" });
    // An unapproved replacement does not retire the approved incident.
    expect(selectTemporaryIncident([record(base), record(next, pending)], ctx)).toMatchObject({ kind: "apply", incidentId: "syn-routine-delay" });
    const parsed = temporaryIncidentSchema.parse(base);
    const revoked = revokeTemporaryIncident(parsed, "2026-11-11T09:30:00Z", "Incident clos par l’équipe SYN");
    expect(revoked.revision).toBe(2);
    expect(parsed.status).toBe("active");
    expect(selectTemporaryIncident([record(parsed), record(revoked)], ctx)).toEqual({ kind: "none", reason: "revoked" });
    expect(() => revokeTemporaryIncident(revoked, "2026-11-11T09:31:00Z", "Double révocation")).toThrow("TEMPORARY_ALREADY_REVOKED");
  });
});
