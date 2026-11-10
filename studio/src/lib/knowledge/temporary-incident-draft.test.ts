import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../test/sav-db";
import { contentChunks, contentItems, contentVersions, knowledgeFamilies, knowledgeProjections, savKnowledgeActivations, savKnowledgeProposalDrafts } from "@/db/schema";
import { saveSavKnowledgeProposal } from "./proposals";
import { prepareTemporaryIncidentDraft } from "./temporary-incident-draft";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
const now = new Date("2026-11-10T12:00:00Z");
const input = { id: "syn-routine-delay", title: "SYN routine en retard", family: "usage", productArea: "Routines", knownSince: "2026-11-10T08:00:00Z", validUntil: "2026-11-12T08:00:00Z",
  reply: "L’équipe examine le retard de cette routine.", source: "Signalement interne SYN à vérifier" };
beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30000);
afterAll(async () => { await fixture?.client.close(); });

it("prepares a proposed incident only, records actual preparation time and invents no source reference", () => {
  const prepared = prepareTemporaryIncidentDraft(input, now);
  expect(prepared.mode).toBe("new"); expect(prepared.sources).toEqual([]);
  expect(prepared.document.temporaryIncident).toMatchObject({ id: input.id, status: "active", fix: { level: "none" }, provenance: { source: input.source, recordedAt: now.toISOString() } });
});
it.each([{ family: "finance" }, { family: "cancellation" }, { validUntil: "2027-01-01T00:00:00Z" }, { validUntil: input.knownSince }, { reply: "Le problème est corrigé." }, { id: "customer@example.invalid" }])("rejects a sensitive, unbounded or unsupported incident", patch => {
  expect(() => prepareTemporaryIncidentDraft({ ...input, ...patch }, now)).toThrow();
});
it("saves a draft through the existing proposal pipeline without creating a family, item, projection, version, activation or chunk", async () => {
  const prepared = prepareTemporaryIncidentDraft(input, now);
  const draft = await saveSavKnowledgeProposal(prepared, "contact@limova.ai");
  expect(draft).toMatchObject({ status: "draft", mode: "new", candidateId: null, targetItemId: null });
  expect(draft.document.temporaryIncident?.id).toBe(input.id);
  expect(await fixture.db.select().from(savKnowledgeProposalDrafts)).toHaveLength(1);
  for (const table of [knowledgeFamilies, contentItems, contentVersions, knowledgeProjections, savKnowledgeActivations, contentChunks])
    expect(await fixture.db.select().from(table)).toHaveLength(0);
});
