import { describe, expect, it, vi } from "vitest";
import { createSavIntakeSemanticReaders, type IntakeGeminiCall, type IntakeModelTrace } from "./model-readers";
import { SAV_VISUAL_INVALID_BOX_NOTE, SAV_VISUAL_TRUNCATED_NOTE } from "./output-normalization";
import { intakeDiagnosticPayload } from "./run-diagnostics";
import { encryptSavPayload } from "../crypto";
import type { SavAttachmentObservation } from "../attachment-contract";

const mid = "10000000-0000-4000-8000-000000000001", tid = "20000000-0000-4000-8000-000000000001", at = "2026-10-25T20:26:00.000Z";
const message = { id: mid, threadId: tid, receivedAt: at, fromEmail: "client@example.test", toEmails: ["support@example.test"], direction: "inbound" as const,
  currentText: "Bonjour, ça ne fonctionne pas, voir les captures jointes. Merci de votre aide rapide sur ce point.", contentComplete: true };
const hashA = "a".repeat(64), hashB = "b".repeat(64);
const obs = (i: number, h: string): SavAttachmentObservation => ({ sourceId: `attachment:${i}`, filename: `capture${i}.png`, mimeType: "image/png", referenceHash: `r${i}`, fileHash: h,
  width: 800, height: 600, status: "not_read", reason: "in_progress", text: "", uncertainties: [], regions: [] } as SavAttachmentObservation);
const img = (h: string) => ({ bytes: Buffer.from("x"), mimeType: "image/png" as const, width: 800, height: 600, hash: h });
function prepared(count = 2) {
  const o = [obs(0, hashA), obs(1, hashB)].slice(0, count), u = [img(hashA), img(hashB)].slice(0, count);
  return { observations: o, selected: o.map((observation, imageIndex) => ({ observation, image: u[imageIndex], imageIndex })), uniqueImages: u } as never;
}
type Arg = Parameters<IntakeGeminiCall>[0];
const anchor = (arg: Arg) => (JSON.parse(arg.body.contents[0].parts[0].text).citationCatalogue as { id: string; sourceId: string }[]).find(a => a.sourceId === "current")!.id;
const image = (index: number) => ({ index, readability: "readable", text: "Erreur 500 affichée", uncertainties: [], regions: [{ text: "Erreur 500", box: [10, 20, 300, 400] }] });
const answer = (arg: Arg, images = 2) => ({ messageId: mid, requests: [{ id: "r0", kind: "support", currentMessageId: mid, quoteId: anchor(arg) }],
  ticketSummary: { title: "Erreur 500", description: "Le client signale une erreur.", requestIds: ["r0"] }, images: Array.from({ length: images }, (_, i) => image(i)) });
const meta = { inputTokens: 1, outputTokens: 1, thoughtTokens: 0, totalTokens: 2 };
type Img = { index: number; readability: string; text: string; uncertainties: string[]; regions: { text: string; box: unknown }[] };
type Raw = { messageId: string; requests: { quoteId: string }[]; ticketSummary: { title: string }; images: Img[]; [key: string]: unknown };

/** Same order as model-dispatch: the provider JSON goes through sanitizeResponse first. */
async function run(mutate: (v: Raw) => void, options: { images?: number } = {}) {
  const traces: IntakeModelTrace[] = [], bodies: Arg[] = [];
  let observations: SavAttachmentObservation[] = [];
  const call: IntakeGeminiCall = async arg => {
    bodies.push(arg);
    const raw = answer(arg, options.images ?? 2) as Raw; mutate(raw);
    return { json: arg.media ? arg.sanitizeResponse!(raw) : raw, metadata: meta };
  };
  const reader = createSavIntakeSemanticReaders({ model: "gemini-fixture", call, onTrace: t => traces.push(t),
    ...(options.images === 0 ? {} : { attachments: { prepared: prepared(options.images ?? 2), onRead: o => { observations = o; } } }) });
  let outcome: unknown;
  try { outcome = await reader.analyseMessage({ message, conversation: [] }, new AbortController().signal); } catch (error) { outcome = (error as Error).message; }
  return { outcome, traces, bodies, observations };
}

describe("visual contract: bounded overflows become partial, structure stays strict", () => {
  it("baseline: two readable images accepted in one call, nothing normalized", async () => {
    const r = await run(() => {});
    expect(r.outcome).toMatchObject({ messageId: mid });
    expect(r.bodies).toHaveLength(1);
    expect(r.observations.map(o => o.status)).toEqual(["analyzed", "analyzed"]);
    expect(r.traces.at(-1)).toMatchObject({ accepted: true }); expect(r.traces.at(-1)?.normalization).toBeUndefined();
  });
  it.each([
    ["ocr_text_4500", (v: Raw) => { v.images[0].text = "Ligne de log ".repeat(375); }, { truncatedImageTexts: 1 }],
    ["uncertainties_9", (v: Raw) => { v.images[0].uncertainties = Array.from({ length: 9 }, (_, i) => `doute ${i}`); }, { droppedUncertainties: 2 }],
    ["regions_9", (v: Raw) => { v.images[0].regions = Array.from({ length: 9 }, () => ({ text: "zone", box: null })); }, { droppedRegions: 1 }],
    ["region_text_1200", (v: Raw) => { v.images[0].regions[0].text = "zone ".repeat(240); }, { truncatedRegionTexts: 1 }],
  ])("%s: accepted, image partial, explicit note and counters", async (_name, mutate, counted) => {
    const r = await run(mutate);
    expect(r.outcome).toMatchObject({ messageId: mid });
    expect(r.bodies).toHaveLength(1);
    expect(r.observations[0]).toMatchObject({ status: "partial", reason: "partial_content" });
    expect(r.observations[0].uncertainties[0]).toBe(SAV_VISUAL_TRUNCATED_NOTE);
    expect(r.observations[1].status).toBe("analyzed");
    expect(r.traces.at(-1)?.normalization).toMatchObject({ partialImages: 1, ...counted });
  });
  it.each([[[10, 20, 1200, 900]], [[10, 20, 300]]])("unreliable box %j: location dropped with warning, text kept", async box => {
    const r = await run(v => { v.images[0].regions[0].box = box; });
    expect(r.outcome).toMatchObject({ messageId: mid });
    expect(r.observations[0].regions[0]).toEqual({ text: "Erreur 500", box: null });
    expect(r.observations[0].uncertainties).toContain(SAV_VISUAL_INVALID_BOX_NOTE);
    expect(r.traces.at(-1)?.normalization).toMatchObject({ invalidBoxes: 1 });
  });
  it.each([
    ["index_out_of_range", (v: Raw) => { v.images[1].index = 3; }, "sanitize_wire", "output_schema_invalid", "images.1.index"],
    ["duplicate_index", (v: Raw) => { v.images[1].index = 0; }, "decode", "visual_structure_invalid", "images"],
    ["missing_image", (v: Raw) => { v.images.pop(); }, "decode", "visual_structure_invalid", "images"],
    ["extra_image", (v: Raw) => { v.images.push(image(2)); }, "decode", "visual_structure_invalid", "images"],
    ["unknown_readability", (v: Raw) => { v.images[0].readability = "blurry"; }, "sanitize_wire", "output_schema_invalid", "images.0.readability"],
    ["unknown_key", (v: Raw) => { v.confidence = 0.9; }, "sanitize_wire", "output_schema_invalid", "output"],
    ["non_numeric_box", (v: Raw) => { v.images[0].regions[0].box = ["a", "b", "c", "d"]; }, "sanitize_wire", "output_schema_invalid", "images.0.regions.0.box.0"],
    ["bad_file_hash", (v: Raw) => { v.imageRequirements = [{ sourceId: "attachment:0", fileHash: hashA.toUpperCase(), role: "required" }]; }, "sanitize_wire", "output_schema_invalid", "imageRequirements.0.fileHash"],
    ["title_130_chars", (v: Raw) => { v.ticketSummary.title = "T".repeat(130); }, "sanitize_wire", "output_schema_invalid", "ticketSummary.title"],
    ["nested_null", (v: Raw) => { v.registration = { address: null, sourceMessageId: mid, quoteId: "q1" }; }, "sanitize_wire", "output_schema_invalid", "registration.address"],
  ])("%s: still rejected in one call, stage and path diagnosed", async (_name, mutate, stage, reason, path) => {
    const r = await run(mutate);
    expect(r.outcome).toBe("SAV_INTAKE_MODEL_OUTPUT_REJECTED");
    expect(r.bodies).toHaveLength(1); // no hidden visual repair inside the attempt
    expect(r.traces.at(-1)?.validationFailure).toMatchObject({ reason, stage, path });
  });
  it.each(["nature", "registration", "ticketSummary", "imageRequirements"])("%s: null on the visual path is treated as absent", async key => {
    const r = await run(v => { v[key] = null; });
    expect(r.outcome).toMatchObject({ messageId: mid });
    expect(r.outcome).not.toHaveProperty(key);
    expect(r.traces.at(-1)?.normalization).toMatchObject({ nullOptionalKeys: 1 });
  });
  it("prompt carries the validator limits", async () => {
    const r = await run(() => {});
    const data = JSON.parse(r.bodies[0].body.contents[0].parts[0].text) as { visualInstructions: string };
    expect(data.visualInstructions).toContain("at most 4000 characters");
    expect(data.visualInstructions).toContain("[ymin, xmin, ymax, xmax] normalized from 0 to 1000");
    expect(r.bodies[0].body.systemInstruction.parts[0].text).toContain("ticketSummary.title at most 120 characters");
  });
});

describe("text-only path", () => {
  it("accepts null optional keys, rejects unknown keys at the final schema, keeps evidence checks", async () => {
    expect((await run(v => { v.nature = null; delete (v as Partial<Raw>).images; }, { images: 0 })).outcome).toMatchObject({ messageId: mid });
    const extra = await run(v => { v.confidence = 1; delete (v as Partial<Raw>).images; }, { images: 0 });
    expect(extra.outcome).toBe("SAV_INTAKE_MODEL_OUTPUT_REJECTED");
    expect(extra.traces.find(t => t.validationFailure)?.validationFailure).toMatchObject({ reason: "output_schema_invalid", stage: "final_schema" });
    const forged = await run(v => { v.requests[0].quoteId = "q9999"; delete (v as Partial<Raw>).images; }, { images: 0 });
    expect(forged.traces.find(t => t.validationFailure)?.validationFailure).toMatchObject({ reason: "unknown_anchor", stage: "decode" });
  });
});

it("admin diagnostics project the stage and counters as allow-listed values only", () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-contract-encryption-key-32-characters");
  const payload = intakeDiagnosticPayload(encryptSavPayload({ traces: [{ phase: "understanding", accepted: false, errorCode: "SAV_INTAKE_MODEL_OUTPUT_REJECTED",
    validationFailure: { reason: "visual_structure_invalid", path: "images", stage: "decode" },
    normalization: { partialImages: 1, truncatedImageTexts: 1, omittedChars: 500, PRIVATE: "secret" } },
    { phase: "understanding", validationFailure: { reason: "output_schema_invalid", stage: "PRIVATE STAGE" } }] }));
  expect(payload.traces[0]).toMatchObject({ validationReason: "visual_structure_invalid", validationStage: "decode",
    normalization: { partialImages: 1, truncatedImageTexts: 1, omittedChars: 500, invalidBoxes: null } });
  expect(payload.traces[1].validationStage).toBeNull();
  expect(JSON.stringify(payload)).not.toContain("PRIVATE");
  expect(JSON.stringify(payload)).not.toContain("secret");
});
