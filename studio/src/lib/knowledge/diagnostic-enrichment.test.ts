import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { contentItems, contentVersions, savKnowledgeActivations, savKnowledgeProposalDrafts } from "@/db/schema";
import { prepareSavDiagnosticEnrichment, enrichSavDiagnosticDocument } from "./diagnostic-enrichment";
import { saveSavKnowledgeProposal } from "./proposals";
import { canonicalKnowledgeSchema } from "./contracts";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
let f: Awaited<ReturnType<typeof createSavTestDb>>;
beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30000);
afterAll(async () => { await f?.client.close(); });
it("covers every active card across pages without changing active versions, verification or existing drafts", async () => {
  const metadata = { intents: [], limovaPaths: [], prerequisites: ["Accéder à l’espace fictif."], expectedResult: "Nom fictif enregistré.", troubleshooting: "Demander une vérification humaine.", resolution: { symptoms: ["Nom incorrect"], steps: ["Ouvrir les paramètres fictifs de l’espace."], exceptions: [], escalation: "Demander une vérification humaine.", productVersion: "", supersedes: [], conflictsWith: [] } };
  for (let index = 0; index < 24; index++) {
    const [item] = await f.db.insert(contentItems).values({ slug: `synthetic-diagnostic-${index}`, type: "article", title: `Procédure fictive ${index}`, agentKey: "sav", ownerEmail: "ugo@limova.ai", status: "published", aiEnabled: true, verifiedAt: new Date("2026-01-01") }).returning();
    const [version] = await f.db.insert(contentVersions).values({ itemId: item.id, version: 1, bodyMarkdown: metadata.resolution.steps[0], metadata, authorEmail: "ugo@limova.ai", changeNote: "Fixture synthétique" }).returning();
    await f.db.update(contentItems).set({ currentDraftVersionId: version.id, publishedVersionId: version.id }).where(eq(contentItems.id, item.id));
    await f.db.insert(savKnowledgeActivations).values({ itemId: item.id, versionId: version.id, title: item.title, activatedBy: "ugo@limova.ai" });
  }
  const before = await f.db.select().from(savKnowledgeActivations);
  const first = await prepareSavDiagnosticEnrichment({}, "contact@limova.ai"); expect(first.results).toHaveLength(20); expect(first.next).toBeTruthy();
  const second = await prepareSavDiagnosticEnrichment({ afterId: first.next! }, "contact@limova.ai"); expect(second.results).toHaveLength(4); expect(second.next).toBeNull();
  expect(await f.db.select().from(savKnowledgeActivations)).toEqual(before);
  expect(await f.db.select().from(savKnowledgeProposalDrafts)).toHaveLength(24);
  const replay = await prepareSavDiagnosticEnrichment({}, "ugo@limova.ai"); expect(replay.results.every(r => r.status === "preserved")).toBe(true);
  expect((await f.db.select().from(contentItems)).every(item => item.verifiedAt?.toISOString().startsWith("2026-01-01"))).toBe(true);
});
it("adds no invented fact, cause, branch or observable result", () => {
  const document = canonicalKnowledgeSchema.parse({ schemaVersion: 1, objective: "Procédure fictive", applicability: "sav_only", locale: "fr-FR", prerequisites: [], expectedResult: "", escalation: "Revue humaine", steps: [{ id: "test.step", userLabel: "Étape", objective: "Procédure fictive", instruction: "Ouvrir le panneau fictif.", escalation: "Revue humaine", expectedResult: "" }] });
  const enriched = enrichSavDiagnosticDocument(document);
  expect(enriched.diagnostic).toBeUndefined();
  expect(enriched).toEqual(document);
  expect(enrichSavDiagnosticDocument(enriched)).toEqual(enriched);
});

it.each(["draft", "published"])("rejects enrichment if the %s version changes after its initial inventory read", async kind => {
  const metadata = { intents: [], limovaPaths: [], prerequisites: [], expectedResult: "", troubleshooting: "", resolution: { symptoms: [], steps: ["Ouvrir le panneau fictif."], exceptions: [], escalation: "Revue humaine", productVersion: "", supersedes: [], conflictsWith: [] } };
  const [item] = await f.db.insert(contentItems).values({ slug: `race-${kind}`, type: "article", title: "Procédure fictive", agentKey: "sav", ownerEmail: "ugo@limova.ai", status: "published", aiEnabled: true }).returning();
  const [active] = await f.db.insert(contentVersions).values({ itemId: item.id, version: 1, bodyMarkdown: "Ouvrir le panneau fictif.", metadata, authorEmail: "ugo@limova.ai", changeNote: "Fixture" }).returning();
  await f.db.update(contentItems).set({ currentDraftVersionId: active.id, publishedVersionId: active.id }).where(eq(contentItems.id, item.id));
  await f.db.insert(savKnowledgeActivations).values({ itemId: item.id, versionId: active.id, title: item.title, activatedBy: "ugo@limova.ai" });
  // The batch has read the active source. A human saves/publishes before persistence acquires the item lock.
  const document = enrichSavDiagnosticDocument(canonicalKnowledgeSchema.parse({ schemaVersion: 1, objective: item.title, applicability: "sav_only", locale: "fr-FR", prerequisites: [], expectedResult: "", escalation: "Revue humaine", steps: [{ id: "fixture.step", userLabel: "Étape", objective: item.title, instruction: "Ouvrir le panneau fictif.", escalation: "Revue humaine", expectedResult: "" }] }));
  const [changed] = await f.db.insert(contentVersions).values({ itemId: item.id, version: 2, bodyMarkdown: "MODIFICATION_HUMAINE", metadata, authorEmail: "ugo@limova.ai", changeNote: "Mise à jour humaine" }).returning();
  await f.db.update(contentItems).set(kind === "draft" ? { currentDraftVersionId: changed.id } : { publishedVersionId: changed.id }).where(eq(contentItems.id, item.id));
  await expect(saveSavKnowledgeProposal({ preparationKind: "diagnostic_enrichment", mode: "improve", targetItemId: item.id, title: item.title, document, sources: [{ ref: `content:${item.id}:${active.id}`, label: "Version active" }], reason: "Enrichissement de la procédure existante." }, "ugo@limova.ai")).rejects.toThrow("KNOWLEDGE_SOURCE_STALE");
  expect(await f.db.select().from(savKnowledgeProposalDrafts).where(eq(savKnowledgeProposalDrafts.targetItemId, item.id))).toHaveLength(0);
});

it("never turns conditional questions, alternatives or internal wording into requirements or branches", () => {
  const document = canonicalKnowledgeSchema.parse({ schemaVersion: 1, objective: "Options fictives", applicability: "sav_only", locale: "fr-FR", prerequisites: [], expectedResult: "", escalation: "Revue humaine", steps: [
    { id: "option.first", userLabel: "Premier accès", objective: "Un accès", instruction: "Utiliser la première entrée fictive. Si une erreur apparaît, demander son texte.", expectedResult: "", escalation: "" },
    { id: "option.other", userLabel: "Autre accès", objective: "Un autre accès", instruction: "Utiliser plutôt la seconde entrée fictive, sans compte à créer.", expectedResult: "", escalation: "" },
  ] });
  expect(enrichSavDiagnosticDocument(document)).toEqual(document);
});
