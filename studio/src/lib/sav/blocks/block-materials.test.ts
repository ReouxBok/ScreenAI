import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { savAiTransportTraceSchema } from "../understanding";
import { createSavTestDb } from "../../../../test/sav-db";
import { auditLogs, contentItems, knowledgeProjectionCandidates, savKnowledgeActivations, savKnowledgeProposalDrafts, savSyncState } from "@/db/schema";
import { emptySavBlockBrief } from "./block-brief";
import { SAV_BLOCK_LESSONS } from "./lesson-controls";
import { blockMaterialsIndex, blockMaterialsSchema, measureBlockMaterials, prepareBlockMaterials, splitBlockPhrases } from "./block-materials";
import { generateBlockMaterials, readBlockMaterials, saveBlockMaterials } from "./block-materials-admin";
import { saveSavBlockBuilder } from "./block-builder-admin";
import { reserveSavDerivedCall, savDerivedCostQuote, dispatchSavDerivedCall } from "../derived-budget";
import { prepareBlockMaterialsAction } from "@/app/studio/sav/blocs/assistant/actions";

const state = vi.hoisted(() => ({ db: null as unknown, authorized: true, calls: vi.fn() }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
vi.mock("../intake/execution-policy", () => ({ executionAdministrator: async () => {
  if (!state.authorized) throw Error("UNAUTHORIZED"); return { email: "contact@limova.ai" };
} }));
vi.mock("../gemini-transport", () => ({ requestSavGeminiJson: state.calls }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
const brief = { ...emptySavBlockBrief("synthetic-block"), objective: "Renommer un espace synthétique", examples: ["Renommer un espace de démonstration"],
  exclusions: ["Ajouter un membre"], neighbours: ["Inviter un collaborateur"], humanOnly: ["Finance"], transferTo: "Support",
  resolutionProof: "Le nouveau nom apparaît dans la liste", lessons: Object.fromEntries(SAV_BLOCK_LESSONS.map(row => [row.id, { confirmed: true, plan: "Vérifier le résultat avec des données synthétiques" }])) };
beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30_000);
afterAll(async () => { await fixture?.client.close(); vi.unstubAllEnvs(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-block-materials-encryption-key"); vi.stubEnv("SAV_BLOCK_BUILDER_AI", "");
  state.authorized = true; state.calls.mockReset();
  await fixture.client.exec("TRUNCATE audit_logs, sav.sync_state, sav_knowledge_proposal_drafts CASCADE");
});
it("creates exactly 24 unique phrases, eight held out and absent from the local index, with neighbours and mixed cases", () => {
  const materials = prepareBlockMaterials(brief), split = splitBlockPhrases(materials);
  expect(split).toHaveLength(24); expect(split.filter(row => row.reserved)).toHaveLength(8);
  expect(split.filter(row => row.reserved && row.kind === "neighbour")).toHaveLength(2);
  expect(split.filter(row => row.kind === "trap")).toHaveLength(6);
  for (const phrase of split.filter(row => row.reserved)) expect(blockMaterialsIndex(materials)).not.toContain(phrase.text);
  expect(blockMaterialsIndex(materials)).toHaveLength(8);
  expect(() => prepareBlockMaterials(emptySavBlockBrief("incomplete"))).toThrow();
  expect(() => blockMaterialsSchema.parse({ ...materials, phrases: Array(24).fill(materials.phrases[0]) })).toThrow();
});
it("reports real baseline counts and does not claim unavailable semantic routing", () => {
  const result = measureBlockMaterials(brief, prepareBlockMaterials(brief));
  expect(result.phrases).toBe(24); expect(result.top3).toEqual({ hits: 12, total: 12, rate: 1 });
  expect(result.neighbourRejection).toEqual({ hits: 6, total: 6, rate: 1 });
  expect(result.traps).toEqual({ hits: 2, total: 6, rate: 1 / 3 });
  expect(result.gate).toMatchObject({ passed: false, reasons: ["trap_failed"] });
});
it.each([undefined, "false", "1", "TRUE"])("AI setting %s makes no provider call even if requested", async value => {
  if (value === undefined) delete process.env.SAV_BLOCK_BUILDER_AI; else vi.stubEnv("SAV_BLOCK_BUILDER_AI", value);
  expect(await generateBlockMaterials(brief, true)).toEqual(prepareBlockMaterials(brief)); expect(state.calls).not.toHaveBeenCalled();
});
it("AI is opt in, uses the knowledge transport, and validates its output", async () => {
  vi.stubEnv("SAV_BLOCK_BUILDER_AI", "true");
  await generateBlockMaterials(brief, false); expect(state.calls).not.toHaveBeenCalled();
  state.calls.mockResolvedValue({ json: prepareBlockMaterials(brief) }); await generateBlockMaterials(brief, true);
  expect(state.calls).toHaveBeenCalledWith(expect.objectContaining({ phase: "block_builder", allowRetry: false, model: "gemini-3.6-flash" }));
  state.calls.mockResolvedValue({ json: {} }); await expect(generateBlockMaterials(brief, true)).rejects.toThrow();
});
it("saves only a proposal draft, never publishes, activates or indexes; retries preserve the proposal", async () => {
  await saveSavBlockBuilder(brief, true); const id = await saveBlockMaterials(brief.blockId);
  expect(await saveBlockMaterials(brief.blockId, true)).toBe(id);
  expect(await fixture.db.select().from(savKnowledgeProposalDrafts)).toMatchObject([{ id, status: "draft", document: { steps: [] }, sources: [] }]);
  for (const table of [contentItems, knowledgeProjectionCandidates, savKnowledgeActivations]) expect(await fixture.db.select().from(table)).toHaveLength(0);
  expect(await readBlockMaterials(brief.blockId)).toMatchObject({ draftId: id });
  await saveSavBlockBuilder({ ...brief, objective: "Objectif synthétique modifié" }, true);
  expect(await readBlockMaterials(brief.blockId)).toBeNull(); expect(state.calls).not.toHaveBeenCalled();
});
it("rejects unauthorized material actions and readers before all effects", async () => {
  state.authorized = false;
  for (const call of [() => readBlockMaterials(brief.blockId), () => saveBlockMaterials(brief.blockId, true), () => prepareBlockMaterialsAction(new FormData())]) await expect(call()).rejects.toThrow("UNAUTHORIZED");
  expect(await fixture.db.select().from(savSyncState)).toHaveLength(0); expect(state.calls).not.toHaveBeenCalled();
});
it("bounds each call below $0.20 and concurrent daily reservations below $2 with the stricter existing budget", async () => {
  const quote = savDerivedCostQuote("gemini-3.6-flash", 8192, new Date(), "block_builder");
  expect(quote.reservedNanoUsd).toBe(79_872_000); expect(quote.reservedNanoUsd).toBeLessThanOrEqual(200_000_000);
  const results = await Promise.allSettled(Array.from({ length: 14 }, () => reserveSavDerivedCall("block_builder", "gemini-3.6-flash", 8192)));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(12);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(2);
  const rows = await fixture.db.select().from(auditLogs);
  expect(rows.filter(row => row.action === "sav_derived_call_reserved").reduce((sum, row) => sum + Number(row.technicalMetadata.reservedNanoUsd), 0)).toBe(958_464_000);
  await expect(reserveSavDerivedCall("block_builder", "unpriced-model", 8192)).rejects.toThrow("UNPRICED");
});
it("refuses oversized wire bodies before dispatch and fences duplicate dispatch", async () => {
  const { reservationId } = await reserveSavDerivedCall("block_builder", "gemini-3.6-flash", 8192);
  const body = { systemInstruction: { parts: [{ text: "Données synthétiques" }] }, contents: [{ parts: [{ text: "x".repeat(65536) }] }], generationConfig: { maxOutputTokens: 8192 } };
  await expect(dispatchSavDerivedCall(reservationId, "block_builder", "gemini-3.6-flash", body)).rejects.toThrow("UNBOUNDED");
  body.contents[0].parts[0].text = "synthétique";
  await dispatchSavDerivedCall(reservationId, "block_builder", "gemini-3.6-flash", body);
  await expect(dispatchSavDerivedCall(reservationId, "block_builder", "gemini-3.6-flash", body)).rejects.toThrow("MISMATCH");
});
it.each([200, 503])("real transport reserves and dispatches once with a synthetic HTTP %s boundary", async status => {
  const { requestSavGeminiJson } = await vi.importActual<typeof import("../gemini-transport")>("../gemini-transport");
  const network = vi.fn<typeof fetch>().mockResolvedValue(status === 200 ? Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"synthetic":true}' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } }) : new Response("", { status }));
  const call = requestSavGeminiJson({ phase: "block_builder", apiKey: "synthetic-key", model: "gemini-3.6-flash", fetch: network, allowRetry: false,
    body: { systemInstruction: { parts: [{ text: "Données synthétiques" }] }, contents: [{ parts: [{ text: "Squelette" }] }], generationConfig: { maxOutputTokens: 8192 } } });
  if (status === 200) {
    const result = await call;
    expect(result).toMatchObject({ json: { synthetic: true } });
    expect(savAiTransportTraceSchema.parse(result.metadata.transport).phase).toBe("block_builder");
  } else await expect(call).rejects.toThrow("HTTP_503");
  expect(network).toHaveBeenCalledOnce();
  const rows = (await fixture.db.select().from(auditLogs)).filter(row => row.action === "sav_derived_call_reserved");
  expect(rows).toHaveLength(1); expect(rows[0].technicalMetadata).toMatchObject({ stage: "block_builder", reservedNanoUsd: 79_872_000, dispatchedAt: expect.any(String) });
});
