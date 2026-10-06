import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { categories, contentItems, contentVersions, knowledgeFamilies, knowledgeFamilyRevisions, knowledgeFamilySources, knowledgeProjectionCandidates } from "@/db/schema";
import { importHubspotKnowledge, hubspotComparison, knowledgeComparisonInventory } from "./hubspot-import";
import { reviewKnowledgeCandidate } from "./review";
import { compareKnowledge, parseHubspotKnowledgeImport } from "./hubspot-input";
import { savProjectionBody } from "./conversion";
import { publish, setContentAiEnabled } from "@/lib/workflow";
import { searchKnowledge } from "@/lib/search";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
vi.mock("@/lib/embeddings", () => ({ embedTexts: vi.fn(async (texts: string[]) => texts.map(() => Array(768).fill(1))) }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30_000);
afterAll(async () => { await fixture?.client.close(); });
beforeEach(async () => {
  await fixture.client.exec("TRUNCATE knowledge_families, content_items, categories CASCADE; TRUNCATE audit_logs");
  await fixture.db.insert(categories).values({ slug: "depannage", label: "Dépannage" });
});
function bundle() {
  // Synthetic knowledge only; no production procedure or customer data.
  const title = "Configurer un export de démonstration";
  return { schemaVersion: 1, namespace: "fixture", entries: [{ externalId: "kb01", title,
    document: { schemaVersion: 1, objective: title, applicability: "sav_only", locale: "fr-FR", productVersion: "demo",
      prerequisites: [], expectedResult: "Le fichier de test est visible.", exceptions: ["Le mode lecture seule interdit l’export."], escalation: "Faire vérifier le compte de test par un humain.",
      steps: [{ id: "kb01.step-1", userLabel: "Choisir le format", objective: title, instruction: "Sélectionner le format de démonstration.", expectedResult: "Format de test sélectionné.", escalation: "Demander une revue humaine." }],
      supportContext: { symptoms: ["Le fichier de démonstration est absent."], diagnosticQuestions: ["Quel format de test avez-vous choisi ?"], responseTemplate: "Précisez le format de test avant de reprendre la procédure." } },
    provenance: { sources: [{ emailId: "123", url: "https://app.hubspot.com/contacts/1/email/123", date: "2026-09-08T10:00:00.000Z", ticketIds: ["456"] }], validationNotes: ["Exemple fictif, revue humaine requise."] },
  }] };
}
async function imported() {
  const result = await importHubspotKnowledge(JSON.stringify(bundle()), "ugo@limova.ai");
  const [candidate] = await fixture.db.select().from(knowledgeProjectionCandidates).where(eq(knowledgeProjectionCandidates.id, result.candidateIds[0]));
  return candidate;
}
async function approval(candidate: Awaited<ReturnType<typeof imported>>) {
  const comparison = hubspotComparison(candidate, await knowledgeComparisonInventory());
  return { expectedRevisionId: candidate.revisionId, decision: "approve" as const, reason: "Sources et différences examinées dans le test isolé.", comparison: { snapshot: comparison.snapshot, acknowledged: true } };
}
describe("private HubSpot knowledge import", () => {
  it("stages provenance and complete knowledge once, without content, publication or activation", async () => {
    const text = JSON.stringify(bundle());
    const first = await importHubspotKnowledge(text, "ugo@limova.ai");
    const again = await importHubspotKnowledge(text, "ugo@limova.ai");
    expect(first.candidateIds).toEqual(again.candidateIds);
    expect(await fixture.db.select().from(knowledgeProjectionCandidates)).toHaveLength(1);
    expect(await fixture.db.select().from(knowledgeFamilyRevisions)).toHaveLength(1);
    expect((await fixture.db.select().from(knowledgeFamilySources))[0].evidence).toMatchObject(bundle().entries[0].provenance);
    expect(await fixture.db.select().from(contentItems)).toHaveLength(0);
    const [candidate] = await fixture.db.select().from(knowledgeProjectionCandidates);
    expect(candidate.status).toBe("pending");
    expect(candidate.diff.after).toContain("Questions de diagnostic");
    expect(candidate.diff.after).toContain("réponse à adapter");
  });
  it("versions a change to the response template instead of losing it as a duplicate", async () => {
    const candidate = await imported();
    const changed = bundle(); changed.entries[0].document.supportContext.responseTemplate = "Autre réponse fictive à examiner.";
    const result = await importHubspotKnowledge(JSON.stringify(changed), "ugo@limova.ai");
    expect(result.candidateIds).not.toEqual([candidate.id]);
    expect(await fixture.db.select().from(knowledgeFamilyRevisions)).toHaveLength(2);
  });
  it("normalizes old terminology while preserving source evidence", () => {
    const input = bundle(); input.entries[0].document.supportContext.responseTemplate = "Essayer la conversation bêta.";
    const result = parseHubspotKnowledgeImport(JSON.stringify(input));
    expect(result.entries[0].document.supportContext!.responseTemplate).toBe("Essayer Limova 3.");
    expect(result.entries[0].provenance).toEqual(input.entries[0].provenance);
  });
  it("rejects duplicate identities, raw mail fields, unsafe links and non-SAV documents", () => {
    const duplicate = bundle(); duplicate.entries.push(duplicate.entries[0]);
    expect(() => parseHubspotKnowledgeImport(JSON.stringify(duplicate))).toThrow();
    expect(() => parseHubspotKnowledgeImport(JSON.stringify({ ...bundle(), rawEmails: ["private"] }))).toThrow();
    const link = bundle(); link.entries[0].provenance.sources[0].url = "https://hubspot.com.evil.invalid/mail";
    expect(() => parseHubspotKnowledgeImport(JSON.stringify(link))).toThrow();
    const tutorial = bundle(); tutorial.entries[0].document.applicability = "shared";
    expect(() => parseHubspotKnowledgeImport(JSON.stringify(tutorial))).toThrow();
    expect(() => parseHubspotKnowledgeImport("x".repeat(800_001))).toThrow("HUBSPOT_IMPORT_TOO_LARGE");
  });
  it("validates every projection before writing and refuses actors outside SAV", async () => {
    await expect(importHubspotKnowledge(JSON.stringify(bundle()), "other@example.invalid")).rejects.toThrow("SAV_ACCESS_FORBIDDEN");
    const invalid = bundle(); invalid.entries.push({ ...invalid.entries[0], externalId: "kb02", title: "Titre distinct", document: { ...invalid.entries[0].document, objective: "Titre distinct", supportContext: { ...invalid.entries[0].document.supportContext, responseTemplate: "<script>invalid</script>" } } });
    await expect(importHubspotKnowledge(JSON.stringify(invalid), "ugo@limova.ai")).rejects.toThrow();
    expect(await fixture.db.select().from(knowledgeFamilyRevisions)).toHaveLength(0);
  });
  it("requires Ugo and an acknowledgment bound to the current comparison", async () => {
    const candidate = await imported();
    await expect(reviewKnowledgeCandidate(candidate.id, await approval(candidate), "reouven@limova.ai")).rejects.toThrow("KNOWLEDGE_UGO_APPROVAL_REQUIRED");
    await expect(reviewKnowledgeCandidate(candidate.id, { ...await approval(candidate), comparison: undefined }, "ugo@limova.ai")).rejects.toThrow("HUBSPOT_COMPARISON_REVIEW_REQUIRED");
    await expect(reviewKnowledgeCandidate(candidate.id, { ...await approval(candidate), comparison: { acknowledged: true, snapshot: "stale" } }, "ugo@limova.ai")).rejects.toThrow("HUBSPOT_COMPARISON_STALE");
    expect(await fixture.db.select().from(contentItems)).toHaveLength(0);
  });
  it("rejects a previously displayed comparison after another candidate appears", async () => {
    const candidate = await imported(); const input = await approval(candidate);
    const other = bundle(); other.entries[0].externalId = "kb02";
    await importHubspotKnowledge(JSON.stringify(other), "ugo@limova.ai");
    await expect(reviewKnowledgeCandidate(candidate.id, input, "ugo@limova.ai")).rejects.toThrow("HUBSPOT_COMPARISON_STALE");
    expect(hubspotComparison(candidate, await knowledgeComparisonInventory()).findings[0].signal).toBe("duplicate");
  });
  it("retains reviewed diagnostics, response and caveats in a disabled in-review draft", async () => {
    const candidate = await imported();
    const [revision] = await fixture.db.select().from(knowledgeFamilyRevisions).where(eq(knowledgeFamilyRevisions.id, candidate.revisionId));
    const document = { ...revision.document, supportContext: { ...revision.document.supportContext!, responseTemplate: "Réponse fictive corrigée par Ugo." } };
    const approved = await reviewKnowledgeCandidate(candidate.id, { ...await approval(candidate), document }, "ugo@limova.ai");
    const [item] = await fixture.db.select().from(contentItems);
    const [version] = await fixture.db.select().from(contentVersions);
    expect(item).toMatchObject({ status: "in_review", agentKey: "sav", aiEnabled: false, publishedVersionId: null });
    expect(version.id).toBe(approved.materializedVersionId);
    expect(version.bodyMarkdown).toContain(document.supportContext.responseTemplate);
    expect(version.bodyMarkdown).toContain(document.supportContext.diagnosticQuestions[0]);
    expect(version.bodyMarkdown).toContain(document.exceptions[0]);
    expect(version.metadata.sourceMetadata).toHaveProperty("comparisonReview.reviewedBy", "ugo@limova.ai");
    await importHubspotKnowledge(JSON.stringify(bundle()), "ugo@limova.ai");
    expect(await fixture.db.select().from(contentItems)).toHaveLength(1);
  });
  it("allows rejection of a duplicate without approval or content effects", async () => {
    const candidate = await imported();
    await reviewKnowledgeCandidate(candidate.id, { expectedRevisionId: candidate.revisionId, decision: "reject", reason: "Doublon écarté dans le test isolé." }, "ugo@limova.ai");
    expect((await fixture.db.select().from(knowledgeProjectionCandidates))[0].status).toBe("rejected");
    expect(await fixture.db.select().from(contentItems)).toHaveLength(0);
  });
  it("compares published and draft article versions without modifying existing knowledge", async () => {
    const [item] = await fixture.db.insert(contentItems).values({ slug: "existing-fixture", title: bundle().entries[0].title, type: "article", ownerEmail: "ugo@limova.ai", agentKey: "charly" }).returning();
    const versions = await fixture.db.insert(contentVersions).values([1, 2].map((version) => ({ itemId: item.id, version, bodyMarkdown: "Procédure fictive de comparaison.", metadata: { intents: [], limovaPaths: [], prerequisites: [], expectedResult: "", troubleshooting: "" }, changeNote: "Fixture", authorEmail: "ugo@limova.ai" }))).returning();
    await fixture.db.update(contentItems).set({ publishedVersionId: versions[0].id, currentDraftVersionId: versions[1].id }).where(eq(contentItems.id, item.id));
    const candidate = await imported();
    const compared = hubspotComparison(candidate, await knowledgeComparisonInventory());
    expect(compared.findings).toHaveLength(2);
    expect(compared.findings.map((row) => row.versionId).sort()).toEqual(versions.map((row) => row.id).sort());
    const oldSnapshot = compared.snapshot;
    await fixture.db.update(contentVersions).set({ bodyMarkdown: "Une autre règle fictive." }).where(eq(contentVersions.id, versions[1].id));
    expect(hubspotComparison(candidate, await knowledgeComparisonInventory()).snapshot).not.toBe(oldSnapshot);
  });
  it("retrieves complete reviewed knowledge only after separate publication and activation", async () => {
    const candidate = await imported();
    expect(await searchKnowledge({ query: "export démonstration", scope: "sav" })).toMatchObject({ results: [] });
    const approved = await reviewKnowledgeCandidate(candidate.id, await approval(candidate), "ugo@limova.ai");
    expect(await searchKnowledge({ query: "export démonstration", scope: "sav" })).toMatchObject({ results: [] });
    await publish(approved.targetItemId!, "ugo@limova.ai", { expectedVersionId: approved.materializedVersionId! });
    expect(await searchKnowledge({ query: "export démonstration", scope: "sav" })).toMatchObject({ results: [] });
    await setContentAiEnabled(approved.targetItemId!, true, "ugo@limova.ai");
    const found = await searchKnowledge({ query: "export démonstration", scope: "sav" });
    const [version] = await fixture.db.select().from(contentVersions);
    expect(found.results).toHaveLength(1);
    expect(found.results[0].contentVersionId).toBe(approved.materializedVersionId);
    expect(found.results[0].content).toBe(version.bodyMarkdown);
    expect(found.results[0].content).toContain(bundle().entries[0].document.exceptions[0]);
    expect(found.results[0].content).toContain(bundle().entries[0].document.supportContext.responseTemplate);
    expect(await searchKnowledge({ query: "export démonstration", scope: "extension", contentTypes: ["article"] })).toMatchObject({ results: [] });
  });
  it("flags opposing text on a shared topic without arbitrating the product decision", () => {
    const entry = { ref: "content:fixture", versionId: "v1", title: "Restaurer un export de démonstration", body: "Un export de démonstration peut être restauré.", agentKey: "sav" };
    const findings = compareKnowledge({ title: entry.title, body: "Un export de démonstration ne peut pas être restauré." }, [entry]);
    expect(findings[0].signal).toBe("related");
    expect(findings[0].body).toBe(entry.body);
    expect(savProjectionBody(parseHubspotKnowledgeImport(JSON.stringify(bundle())).entries[0].document)).toContain("lecture seule");
  });
  it.skipIf(!process.env.SAV_PRIVATE_IMPORT_FIXTURE)("validates the full private delivery in isolation when explicitly supplied", async () => {
    const path = process.env.SAV_PRIVATE_IMPORT_FIXTURE;
    if (!path) return;
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(path, "utf8");
    const expected = parseHubspotKnowledgeImport(text).entries.length;
    const result = await importHubspotKnowledge(text, "ugo@limova.ai");
    expect(result.processed).toBe(expected);
    expect(result.candidateIds).toHaveLength(expected);
    expect((await importHubspotKnowledge(text, "ugo@limova.ai")).candidateIds).toEqual(result.candidateIds);
    expect(await fixture.db.select().from(knowledgeFamilies)).toHaveLength(expected);
    expect(await fixture.db.select().from(contentItems)).toHaveLength(0);
  }, 30_000);
});
