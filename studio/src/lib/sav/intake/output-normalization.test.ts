import { describe, expect, it } from "vitest";
import { savVisualResultSchema } from "../attachment-reader";
import { SAV_VISUAL_OBSERVATION_LIMITS as V } from "../attachment-contract";
import { normalizeIntakeAnalysisOutput, SAV_VISUAL_INVALID_BOX_NOTE, SAV_VISUAL_TRUNCATED_NOTE, INTAKE_VISUAL_LIMITS_INSTRUCTION, INTAKE_OUTPUT_LIMITS_INSTRUCTION } from "./output-normalization";

const image = (over: Record<string, unknown> = {}) => ({ index: 0, readability: "readable", text: "Erreur 500 affichée", uncertainties: [], regions: [{ text: "Erreur 500", box: [10, 20, 300, 400] }], ...over });
const visual = (raw: unknown) => normalizeIntakeAnalysisOutput(raw, { visual: true });
type Img = { text: string; readability: string; uncertainties: string[]; regions: { text: string; box: unknown }[] };
const first = (value: unknown) => (value as { images: Img[] }).images[0];

describe("visual observations are bounded explicitly, never silently", () => {
  it("leaves a conforming output identical and uncounted", () => {
    const raw = { messageId: "m", images: [image(), image({ index: 1 })] };
    const { value, counts } = visual(raw);
    expect(value).toEqual(raw);
    expect(Object.values(counts).every(v => v === 0)).toBe(true);
  });
  it("keeps a prefix of an over-long text and marks the image partial", () => {
    const text = "Ligne de log ".repeat(400), { value, counts } = visual({ images: [image({ text })] }), img = first(value);
    expect(img.text).toBe(text.slice(0, V.text));
    expect(img.readability).toBe("partial");
    expect(img.uncertainties[0]).toBe(SAV_VISUAL_TRUNCATED_NOTE);
    // Counted on the masked text (the masker trims), never on raw values.
    expect(counts).toMatchObject({ truncatedImageTexts: 1, partialImages: 1, omittedChars: text.trim().length - V.text });
    expect(() => savVisualResultSchema.parse(value)).not.toThrow();
  });
  it("bounds uncertainties, regions and region texts and counts what was dropped", () => {
    const { value, counts } = visual({ images: [image({
      uncertainties: Array.from({ length: 9 }, (_, i) => `doute ${i} ` + "x ".repeat(i === 0 ? 200 : 1)),
      regions: Array.from({ length: 10 }, (_, i) => ({ text: i === 0 ? "zone ".repeat(240) : "zone", box: null })) })] });
    const img = first(value);
    expect(img.regions).toHaveLength(V.regions); expect(img.regions[0].text).toHaveLength(V.regionText);
    expect(img.uncertainties).toHaveLength(V.uncertainties); expect(img.uncertainties[0]).toBe(SAV_VISUAL_TRUNCATED_NOTE);
    expect(img.uncertainties[1].length).toBe(V.uncertainty);
    expect(counts).toMatchObject({ droppedRegions: 2, truncatedRegionTexts: 1, truncatedUncertainties: 1, droppedUncertainties: 2, partialImages: 1 });
    expect(() => savVisualResultSchema.parse(value)).not.toThrow();
  });
  it.each([[[10, 20, 1200, 900]], [[10, 20, 300]], [[-1, 0, 10, 10]], [[0, 0, 10, 10, 10]]])("drops an unreliable numeric box %j with a warning, text kept", box => {
    const { value, counts } = visual({ images: [image({ regions: [{ text: "Erreur 500", box }] })] }), img = first(value);
    expect(img.regions[0]).toEqual({ text: "Erreur 500", box: null });
    expect(img.uncertainties).toEqual([SAV_VISUAL_INVALID_BOX_NOTE]);
    expect(img.readability).toBe("readable"); // the text is complete; only the location is unreliable
    expect(counts).toMatchObject({ invalidBoxes: 1, partialImages: 0 });
  });
  it("never repairs structure: indexes, readability, types, unknown keys and non-numeric boxes still fail", () => {
    for (const bad of [image({ index: 3 }), image({ readability: "blurry" }), image({ text: 42 }), image({ confidence: 1 }),
      image({ regions: [{ text: "x", box: ["a", "b", "c", "d"] }] }), image({ regions: [{ text: "x", box: [1, 2, 3, 4], extra: true }] })]) {
      const { value } = visual({ images: [bad] });
      expect(() => savVisualResultSchema.parse(value)).toThrow();
    }
    // The list of images is never truncated to make a count fit.
    const four = { images: [0, 1, 2, 2].map(index => image({ index })) };
    expect((visual(four).value as { images: unknown[] }).images).toHaveLength(4);
  });
  it("masks secrets before cutting so a prefix never ends inside a secret", () => {
    const token = "A".repeat(30), text = "x ".repeat((V.text - 10) / 2) + `jeton ${token} fin`;
    const img = first(visual({ images: [image({ text })] }).value);
    expect(img.text).not.toContain("AAAAAAAAAA");
    expect(img.text.length).toBeLessThanOrEqual(V.text);
  });
  it("is idempotent", () => {
    const once = visual({ images: [image({ text: "y".repeat(5000), regions: [{ text: "r", box: [1, 2, 3] }] })] });
    const twice = visual(once.value);
    expect(twice.value).toEqual(once.value);
    expect(Object.values(twice.counts).every(v => v === 0)).toBe(true);
  });
  it("leaves images untouched when no visual contract applies", () => {
    const raw = { images: [image({ text: "y".repeat(5000) })] };
    expect(normalizeIntakeAnalysisOutput(raw, { visual: false }).value).toEqual(raw);
  });
});

describe("null becomes absent only for the listed top-level optional keys", () => {
  it.each(["nature", "registration", "ticketSummary", "imageRequirements"])("drops %s: null", key => {
    const { value, counts } = normalizeIntakeAnalysisOutput({ messageId: "m", [key]: null }, { visual: false });
    expect(value).toEqual({ messageId: "m" }); expect(counts.nullOptionalKeys).toBe(1);
  });
  it("keeps every other null, nested null and value for the validator", () => {
    const raw = { messageId: null, requests: null, registration: { address: null }, ticketSummary: { title: null }, images: null, extra: null };
    const { value, counts } = normalizeIntakeAnalysisOutput(raw, { visual: true });
    expect(value).toEqual(raw); expect(counts.nullOptionalKeys).toBe(0);
  });
});

it("prompt limits come from the validator constants", () => {
  expect(INTAKE_VISUAL_LIMITS_INSTRUCTION).toContain(`at most ${V.text} characters`);
  expect(INTAKE_VISUAL_LIMITS_INSTRUCTION).toContain(`at most ${V.regions} regions`);
  expect(INTAKE_VISUAL_LIMITS_INSTRUCTION).toContain(`0 to ${V.coordinate}`);
  expect(INTAKE_OUTPUT_LIMITS_INSTRUCTION).toContain("120 characters");
  for (const key of ["nature", "registration", "ticketSummary", "imageRequirements"]) expect(INTAKE_OUTPUT_LIMITS_INSTRUCTION).toContain(key);
});
