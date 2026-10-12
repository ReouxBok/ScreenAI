import { describe, expect, it } from "vitest";
import { selectSavLeadTemplate } from "./lead-template";
import type { KnowledgeSearchResult } from "../search";

const now = new Date("2026-10-09T12:00:00Z");
const source: KnowledgeSearchResult = { id: "fixture-card", contentVersionId: "fixture-version", title: "Découverte produit fictive", content: "Modèle fictif", score: 0.8,
  source: "fixture", verifiedAt: "2026-10-08", resolution: { audience: "lead", symptoms: ["Lead avant achat"], steps: ["Orienter vers un formulaire fictif"],
    escalation: "Qualification humaine en cas de doute", responseTemplate: "Bonjour, voici un formulaire fictif : https://example.invalid/demo.", conflictsWith: [], supersedes: [] } };
describe("Lead-only response templates", () => {
  it("returns the exact unsigned reviewed template and source version", () => {
    expect(selectSavLeadTemplate([source], now)).toEqual({ source, template: source.resolution!.responseTemplate });
  });
  it.each([
    { score: 0.49 }, { verifiedAt: null }, { verifiedAt: "2026-01-01" }, { verifiedAt: "2026-10-10" }, { contentVersionId: undefined },
    { resolution: { ...source.resolution, audience: "support" } },
    { resolution: { ...source.resolution, validUntil: "2026-10-08" } },
    { resolution: { ...source.resolution, validUntil: "2027-02-31" } },
    { resolution: { ...source.resolution, conflictsWith: ["other-fixture"] } },
    { resolution: { ...source.resolution, responseTemplate: "Bonjour, modèle fictif.\nCharly" } },
  ])("rejects unusable evidence: %s", change => {
    expect(selectSavLeadTemplate([{ ...source, ...change }], now)).toBeNull();
  });
  it("requires exactly one eligible template", () => {
    expect(selectSavLeadTemplate([], now)).toBeNull();
    expect(selectSavLeadTemplate([source, { ...source, id: "other-fixture" }], now)).toBeNull();
  });
});
