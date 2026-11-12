import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/studio/sav/connaissances/workspace-actions", () => ({ previewKnowledgeReviewAction: vi.fn(), reviewKnowledgeWorkspaceAction: vi.fn(), publishKnowledgeWorkspaceAction: vi.fn(), activateKnowledgeWorkspaceAction: vi.fn(), startKnowledgeRevisionAction: vi.fn() }));
import { KnowledgePublication } from "@/app/studio/sav/connaissances/workspace-review";
import { SAV_CARD_PUBLICATION_LIMITS, savCardPublicationWarnings } from "./publication-check";

/*
 * K2 (12/11), SYN only: the publication check of a SAV card warns (never blocks, never truncates) when the card is longer than 5 500
 * characters, has more than 8 steps, or lacks `symptoms` or `escalation`.
 */

const resolution = (over: Record<string, unknown> = {}) => ({ symptoms: ["Le code n'arrive pas."], steps: ["Étape 1", "Étape 2"], exceptions: [], escalation: "Transférer au support.", ...over });
const version = (body: string, res: unknown = resolution()) => ({ bodyMarkdown: body, metadata: { resolution: res } });
const codes = (value: ReturnType<typeof savCardPublicationWarnings>) => value.map(row => row.code);

describe("K2 SAV card publication check", () => {
  it("a complete, short card gets no warning", () => {
    expect(savCardPublicationWarnings(version("Procédure synthétique courte."))).toEqual([]);
    expect(SAV_CARD_PUBLICATION_LIMITS).toEqual({ characters: 5500, steps: 8 });
  });

  it("warns past 5 500 characters (counted as characters, not bytes), exactly at the limit stays silent", () => {
    expect(savCardPublicationWarnings(version("é".repeat(5500)))).toEqual([]);
    const long = savCardPublicationWarnings(version("é".repeat(5501)));
    expect(long).toEqual([{ code: "card_too_long", value: 5501, limit: 5500, label: expect.stringContaining("5501 caractères") }]);
    // An emoji is one character, never two.
    expect(savCardPublicationWarnings(version("🔒".repeat(5500)))).toEqual([]);
  });

  it("warns past 8 steps; 8 steps stays silent", () => {
    const steps = (n: number) => Array.from({ length: n }, (_, i) => `Étape ${i + 1}`);
    expect(savCardPublicationWarnings(version("Fiche.", resolution({ steps: steps(8) })))).toEqual([]);
    expect(savCardPublicationWarnings(version("Fiche.", resolution({ steps: steps(9) })))).toEqual([{ code: "card_too_many_steps", value: 9, limit: 8, label: expect.stringContaining("9 étapes") }]);
  });

  it("warns when symptoms or escalation are missing or blank, and when the card has no resolution at all", () => {
    expect(codes(savCardPublicationWarnings(version("Fiche.", resolution({ symptoms: [] }))))).toEqual(["card_symptoms_missing"]);
    expect(codes(savCardPublicationWarnings(version("Fiche.", resolution({ symptoms: ["   "] }))))).toEqual(["card_symptoms_missing"]);
    expect(codes(savCardPublicationWarnings(version("Fiche.", resolution({ escalation: "  " }))))).toEqual(["card_escalation_missing"]);
    expect(codes(savCardPublicationWarnings(version("Fiche.", resolution({ escalation: undefined }))))).toEqual(["card_escalation_missing"]);
    expect(codes(savCardPublicationWarnings({ bodyMarkdown: "Fiche.", metadata: {} }))).toEqual(["card_symptoms_missing", "card_escalation_missing"]);
    expect(codes(savCardPublicationWarnings({ bodyMarkdown: "Fiche.", metadata: null }))).toEqual(["card_symptoms_missing", "card_escalation_missing"]);
  });

  it("all four at once, in a stable order; the input is never modified (no truncation)", () => {
    const input = version("x".repeat(6000), { steps: Array.from({ length: 12 }, (_, i) => `Étape ${i}`), symptoms: [], escalation: "" });
    const before = JSON.stringify(input);
    expect(codes(savCardPublicationWarnings(input))).toEqual(["card_too_long", "card_too_many_steps", "card_symptoms_missing", "card_escalation_missing"]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("the publication panel shows the warnings and still offers to publish (warning, not a block)", () => {
    const warnings = savCardPublicationWarnings(version("x".repeat(6000), resolution({ symptoms: [] })));
    const id = "00550000-0000-4000-8000-000000000001";
    const html = renderToStaticMarkup(createElement(KnowledgePublication, { itemId: id, proposedVersionId: id, publishedVersionId: null, activeVersionId: null, canPublish: true, canActivate: false, title: "Fiche fictive", warnings }));
    expect(html).toContain("Publier la version validée");
    expect(html).toContain("6000 caractères");
    expect(html).toContain("Aucun symptôme renseigné");
    expect(html).toContain("ne bloque pas la publication");
    const clean = renderToStaticMarkup(createElement(KnowledgePublication, { itemId: id, proposedVersionId: id, publishedVersionId: null, activeVersionId: null, canPublish: true, canActivate: false, title: "Fiche fictive" }));
    expect(clean).not.toContain("ne bloque pas la publication");
  });
});
