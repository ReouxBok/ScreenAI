import { eq } from "drizzle-orm";
import { contentVersions } from "@/db/schema";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../test/sav-db";
import { saveSavPlaybook, reviewSavPlaybook, activateSavPlaybook, readActiveSavPlaybook, getSavPlaybookWorkspace } from "./playbook";
import { knowledgeComparisonInventory } from "@/lib/knowledge/hubspot-import";
import { listContent, publish, setContentAiEnabled } from "@/lib/workflow";
import { defaultSavPlaybook, renderSavPlaybook, savPlaybookSchema } from "./playbook-contract";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
let f: Awaited<ReturnType<typeof createSavTestDb>>;
beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30000);
beforeEach(async () => { await f.client.exec("TRUNCATE content_items CASCADE; TRUNCATE audit_logs"); });
afterAll(async () => { await f?.client.close(); });
it("keeps the existing process until explicit reviewed activation, including for contact", async () => {
  expect((await readActiveSavPlaybook()).version).toBe(0);
  const first = await saveSavPlaybook({ document: defaultSavPlaybook, expectedDraftId: null }, "contact@limova.ai");
  await expect(activateSavPlaybook({ versionId: first.versionId, expectedActiveId: null }, "contact@limova.ai")).rejects.toThrow("SAV_PLAYBOOK_REVIEW_REQUIRED");
  await reviewSavPlaybook(first, "contact@limova.ai");
  await activateSavPlaybook({ ...first, expectedActiveId: null }, "contact@limova.ai");
  expect((await readActiveSavPlaybook()).versionId).toBe(first.versionId);
});
it("preserves history, rejects stale writes and permits explicit rollback of a reviewed version", async () => {
  const first = await saveSavPlaybook({ document: defaultSavPlaybook, expectedDraftId: null }, "ugo@limova.ai"); await reviewSavPlaybook(first, "ugo@limova.ai"); await activateSavPlaybook({ ...first, expectedActiveId: null }, "ugo@limova.ai");
  await expect(saveSavPlaybook({ document: defaultSavPlaybook, expectedDraftId: null }, "contact@limova.ai")).rejects.toThrow("SAV_PLAYBOOK_STALE");
  const next = await saveSavPlaybook({ document: { ...defaultSavPlaybook, tone: "Réponse courte et factuelle." }, expectedDraftId: first.versionId }, "contact@limova.ai"); await reviewSavPlaybook(next, "contact@limova.ai");
  await expect(activateSavPlaybook({ ...next, expectedActiveId: null }, "contact@limova.ai")).rejects.toThrow("SAV_PLAYBOOK_STALE");
  await activateSavPlaybook({ ...next, expectedActiveId: first.versionId }, "contact@limova.ai"); await activateSavPlaybook({ ...first, expectedActiveId: next.versionId }, "ugo@limova.ai");
  expect((await getSavPlaybookWorkspace("contact@limova.ai")).versions).toHaveLength(2); expect((await readActiveSavPlaybook()).versionId).toBe(first.versionId);
});
it("limits playbook management without broadening other SAV actors", async () => {
  for (const actor of ["reouven@limova.ai", "unknown@example.invalid"]) await expect(saveSavPlaybook({ document: defaultSavPlaybook, expectedDraftId: null }, actor)).rejects.toThrow("SAV_PLAYBOOK_ACCESS_FORBIDDEN");
});
it("serializes competing saves and activations instead of accepting both stale expectations", async () => {
  const saves = await Promise.allSettled(["ugo@limova.ai", "contact@limova.ai"].map(actor => saveSavPlaybook({ document: defaultSavPlaybook, expectedDraftId: null }, actor)));
  expect(saves.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(saves.filter(result => result.status === "rejected").map(result => String(result.reason))).toEqual(["Error: SAV_PLAYBOOK_STALE"]);
  const workspace = await getSavPlaybookWorkspace("ugo@limova.ai");
  expect(workspace.versions).toHaveLength(1);
  const first = { versionId: workspace.versions[0].id };
  await reviewSavPlaybook(first, "ugo@limova.ai");
  const second = await saveSavPlaybook({ document: { ...defaultSavPlaybook, tone: "Réponse concise." }, expectedDraftId: first.versionId }, "contact@limova.ai");
  await reviewSavPlaybook(second, "contact@limova.ai");
  const activations = await Promise.allSettled([first, second].map(version => activateSavPlaybook({ ...version, expectedActiveId: null }, "ugo@limova.ai")));
  expect(activations.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(activations.filter(result => result.status === "rejected").map(result => String(result.reason))).toEqual(["Error: SAV_PLAYBOOK_STALE"]);
  expect([first.versionId, second.versionId]).toContain((await readActiveSavPlaybook()).versionId);
});
it("validates a single fact dictionary and injects only relevant domain questions with existing protections", () => {
  expect(savPlaybookSchema.safeParse({ ...defaultSavPlaybook, facts: [defaultSavPlaybook.facts[0], defaultSavPlaybook.facts[0]] }).success).toBe(false);
  const text = renderSavPlaybook({ versionId: "test", version: 1, document: defaultSavPlaybook }, ["seo"]).text;
  expect(text).toContain("page_url"); expect(text).not.toContain("integration_name"); expect(text).toContain("15 jours"); expect(text).toContain("Finance");
});

it("keeps the master prompt out of product inventories and prevents generic publication or AI activation", async () => {
  const version = await saveSavPlaybook({ document: defaultSavPlaybook, expectedDraftId: null }, "ugo@limova.ai");
  await reviewSavPlaybook(version, "ugo@limova.ai"); await activateSavPlaybook({ ...version, expectedActiveId: null }, "ugo@limova.ai");
  const workspace = await getSavPlaybookWorkspace("ugo@limova.ai");
  expect(await knowledgeComparisonInventory()).toEqual([]); expect(await listContent()).toEqual([]);
  await expect(publish(workspace.itemId!, "ugo@limova.ai")).rejects.toThrow("SAV_PLAYBOOK_DEDICATED_WORKSPACE_REQUIRED");
  await expect(setContentAiEnabled(workspace.itemId!, true, "ugo@limova.ai")).rejects.toThrow("SAV_PLAYBOOK_DEDICATED_WORKSPACE_REQUIRED");
});

it("round-trips a long single prompt with exact layout, facts, review and explicit activation", async () => {
  const prompt = ("Méthode fictive : comprendre la demande puis citer la source.\n\n".repeat(85)).trim();
  expect(prompt.length).toBeGreaterThan(4000);
  const saved = await saveSavPlaybook({ document: defaultSavPlaybook, prompt, expectedDraftId: null }, "ugo@limova.ai");
  const workspace = await getSavPlaybookWorkspace("ugo@limova.ai");
  expect(workspace.versions[0].prompt).toBe(prompt);
  const persisted = workspace.versions[0].document;
  expect(persisted.tone.length).toBeLessThanOrEqual(2000); expect(persisted.handling.length).toBeLessThanOrEqual(3000); expect(persisted.escalation.length).toBeLessThanOrEqual(1500);
  expect(persisted.facts).toEqual(defaultSavPlaybook.facts);
  expect(savPlaybookSchema.parse(persisted)).toEqual(persisted);
  expect((await readActiveSavPlaybook()).version).toBe(0);
  await reviewSavPlaybook(saved, "ugo@limova.ai"); await activateSavPlaybook({ ...saved, expectedActiveId: null }, "ugo@limova.ai");
  expect(renderSavPlaybook(await readActiveSavPlaybook(), ["general"]).text).toContain(prompt);
  await expect(saveSavPlaybook({ document: defaultSavPlaybook, prompt: "x".repeat(6001), expectedDraftId: saved.versionId }, "ugo@limova.ai")).rejects.toThrow();
});

it("keeps a valid historical 6504-character concatenation readable and activatable", async () => {
  const saved = await saveSavPlaybook({ document: defaultSavPlaybook, expectedDraftId: null }, "ugo@limova.ai");
  const legacy = savPlaybookSchema.parse({ ...defaultSavPlaybook, tone: "a ".repeat(999) + "aa", handling: "b ".repeat(1499) + "bb", escalation: "c ".repeat(749) + "cc" });
  await f.db.update(contentVersions).set({ metadata: { intents: [], limovaPaths: [], prerequisites: [], expectedResult: "", troubleshooting: "", sourceMetadata: { kind: "sav_playbook", playbook: legacy } } }).where(eq(contentVersions.id, saved.versionId));
  await reviewSavPlaybook(saved, "ugo@limova.ai"); await activateSavPlaybook({ ...saved, expectedActiveId: null }, "ugo@limova.ai");
  expect(renderSavPlaybook(await readActiveSavPlaybook(), ["general"]).text).toContain(legacy.handling);
  expect((await getSavPlaybookWorkspace("ugo@limova.ai")).versions[0].prompt.length).toBe(6504);
});
