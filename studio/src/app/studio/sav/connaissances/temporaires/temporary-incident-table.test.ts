import { describe, expect, it } from "vitest";
import { incidentStateLabel } from "./temporary-incident-table";
import type { TemporaryIncidentPreviewRow } from "@/lib/knowledge/temporary-incidents-read";
import { temporaryIncidentSchema } from "@/lib/knowledge/temporary-incidents";

// SAV-79 R-T2: the screen describes the incident, never claims the state of the knowledge item.
const incident = temporaryIncidentSchema.parse({ schemaVersion: 1, id: "syn-routine-delay", revision: 1, title: "SYN routine en retard", scope: { families: ["usage"], productArea: "Routines" },
  status: "active", knownSince: "2026-11-10T08:00:00Z", validUntil: "2026-11-12T08:00:00Z", approvedReply: "Retard ponctuel ; l’équipe suit le sujet.", fix: { level: "none", evidence: "" },
  provenance: { source: "Déclaration interne SYN", recordedAt: "2026-11-10T08:05:00Z" } });
const row = (patch: Partial<TemporaryIncidentPreviewRow>): TemporaryIncidentPreviewRow => ({ familyId: "f", familyTitle: "SYN", revisionId: "r", revision: 1, revisionApproved: false, reviewState: "pending", incidentApproved: false, expired: false, incident, errors: [], ...patch });

describe("temporary incident state label", () => {
  it("never states the knowledge item as unpublished or inactive", () => {
    for (const label of [incidentStateLabel(row({})), incidentStateLabel(row({ revisionApproved: true, reviewState: "approved", incidentApproved: true }))]) {
      expect(label).not.toMatch(/révision non publiée|fiche non publiée|non active SAV|non indexée/i);
      expect(label).toContain("Jamais projeté dans la fiche ni publié");
      expect(label).toContain("non utilisé par l’agent SAV");
    }
  });
  it("reports the incident approval, expiry and revocation as observed", () => {
    expect(incidentStateLabel(row({}))).toContain("en attente de revue de la révision (pending)");
    expect(incidentStateLabel(row({ revisionApproved: true, reviewState: "approved", incidentApproved: true }))).toContain("approuvé avec la révision");
    expect(incidentStateLabel(row({ revisionApproved: true, reviewState: "approved", incidentApproved: false }))).toContain("sans relecteur SAV reconnu");
    expect(incidentStateLabel(row({ expired: true }))).toContain("Incident expiré");
    expect(incidentStateLabel(row({ incident: null, errors: ["X"] }))).toContain("Incident invalide");
  });
});
