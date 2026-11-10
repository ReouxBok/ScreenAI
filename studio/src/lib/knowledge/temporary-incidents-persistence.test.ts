import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../test/sav-db";
import { contentChunks, contentVersions, knowledgeProjections, savKnowledgeActivations } from "@/db/schema";
import { registerCanonicalKnowledge, getCanonicalFamily } from "./families";
import { canonicalKnowledgeSchema, supportProcedure } from "./contracts";
import { savProjectionBody, savQualifiedProjectionBody } from "./conversion";
import { selectTemporaryIncident } from "./temporary-incidents";
import { getPublishedOnboardingTemplate } from "@/lib/onboarding-template";
import { listTemporaryIncidentPreview } from "./temporary-incidents-read";
import { assertSafeKnowledgeDraft } from "./onboarding-extraction";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30_000);
afterAll(async () => { await fixture?.client.close(); });
beforeEach(async () => { await fixture.client.exec("TRUNCATE knowledge_families, content_items CASCADE; TRUNCATE audit_logs"); });

// Synthetic SYN example only.
const MARKER = "SYN-INCIDENT-MARKER retard ponctuel des routines";
const incident = {
  schemaVersion: 1, id: "syn-routine-delay", revision: 1, title: "SYN routine planifiée en retard",
  scope: { families: ["usage"], productArea: "Routines" },
  status: "active", knownSince: "2026-11-10T08:00:00Z", validUntil: "2026-11-12T08:00:00Z",
  infoToCollect: ["Nom de la routine"], approvedReply: `${MARKER} ; l’équipe suit le sujet.`, fix: { level: "none", evidence: "" },
  provenance: { source: "Déclaration interne SYN", recordedAt: "2026-11-10T08:05:00Z" },
};
const document = canonicalKnowledgeSchema.parse({ schemaVersion: 1, objective: "Créer une routine SYN", applicability: "shared", locale: "fr-FR", expectedResult: "Routine confirmée", escalation: "Transmettre à l’équipe.",
  steps: [{ id: "routine.open", userLabel: "Conversation", objective: "Ouvrir une conversation", instruction: "Ouvrez une nouvelle conversation.", expectedResult: "Conversation ouverte", escalation: "Transmettre." }],
  temporaryIncident: incident });

describe("temporary incident persistence (canonical revision, no migration)", () => {
  it("stores a proposed revision only: not approved, not published, not SAV active, not indexed, not projected", async () => {
    const { family, revision } = await registerCanonicalKnowledge({ canonicalKey: "syn:routine-delay", title: "SYN routine", document, source: { ref: "syn:incident", hash: "c".repeat(64) } }, "ugo@limova.ai");
    const stored = await getCanonicalFamily(family.id);
    expect(stored.family.approvedRevisionId).toBeNull();
    expect(stored.revisions).toHaveLength(1);
    expect(canonicalKnowledgeSchema.parse(stored.revisions[0].document).temporaryIncident).toMatchObject({ id: "syn-routine-delay", status: "active" });
    expect(revision.id).toBe(stored.revisions[0].id);
    expect(stored.projections).toEqual([]);
    expect(await fixture.db.select().from(knowledgeProjections)).toEqual([]);
    expect(await fixture.db.select().from(contentVersions)).toEqual([]);
    expect(await fixture.db.select().from(contentChunks)).toEqual([]);
    expect(await fixture.db.select().from(savKnowledgeActivations)).toEqual([]);
    const preview = await listTemporaryIncidentPreview();
    expect(preview).toHaveLength(1);
    expect(preview[0]).toMatchObject({ familyId: family.id, revision: 1, revisionApproved: false, reviewState: "pending", incidentApproved: false, errors: [] });
    expect(preview[0].incident?.id).toBe("syn-routine-delay");
  });

  it("is excluded from SAV projections, the support procedure and the extension onboarding template", async () => {
    expect(savProjectionBody(document)).not.toContain(MARKER);
    expect(savQualifiedProjectionBody(document)).not.toContain(MARKER);
    expect(JSON.stringify(supportProcedure(document))).not.toContain(MARKER);
    await registerCanonicalKnowledge({ canonicalKey: "syn:routine-delay", title: "SYN routine", document, source: { ref: "syn:incident", hash: "c".repeat(64) } }, "ugo@limova.ai");
    // Extension contract: only published onboarding content is served; a canonical revision never is.
    expect(JSON.stringify(await getPublishedOnboardingTemplate() ?? null)).not.toContain(MARKER);
  });

  it("documents without the field stay valid and the stored incident is still evaluated by the bounded port", () => {
    const { temporaryIncident, ...legacy } = document;
    expect(canonicalKnowledgeSchema.parse(legacy).temporaryIncident).toBeUndefined();
    const now = new Date("2026-11-11T10:00:00Z");
    expect(selectTemporaryIncident([{ incident: temporaryIncident, review: { approved: false, reviewState: "pending", reviewedBy: null } }], { family: "usage", productArea: "routines", now }).kind).toBe("none");
    expect(selectTemporaryIncident([{ incident: temporaryIncident, review: { approved: true, reviewState: "approved", reviewedBy: "ugo@limova.ai" } }], { family: "usage", productArea: "routines", now }).kind).toBe("apply");
    // The stored incident passes the same privacy check as the rest of the canonical document.
    expect(() => assertSafeKnowledgeDraft(document)).not.toThrow();
    expect(() => canonicalKnowledgeSchema.parse({ ...document, temporaryIncident: { ...incident, actions: ["routine_restart"] } })).toThrow();
  });
});
