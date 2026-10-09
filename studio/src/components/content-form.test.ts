import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/app/studio/actions", () => ({ saveContentAction: async () => undefined }));
vi.mock("./markdown-editor", () => ({ MarkdownEditor: () => createElement("textarea", { name: "bodyMarkdown" }) }));
import { ContentForm } from "./content-form";
describe("SAV knowledge editor", () => {
  it("exposes labelled lead, procedure and staff source fields", () => {
    const html = renderToStaticMarkup(createElement(ContentForm, { defaults: { agentKey: "sav", ownerEmail: "staff@example.invalid",
      metadata: { resolution: { audience: "lead", responseTemplate: "Bonjour, modèle fictif sans signature.", symptoms: ["Lead avant achat"], steps: ["Étape fictive"] },
        sourceMetadata: { editorialSource: { reference: "Source fictive", suppliedOn: "2026-10-08" } } } } }));
    for (const id of ["savAudience", "savResponseTemplate", "savSymptoms", "savSteps", "savSourceReference", "savSourceDate", "savEscalation"]) {
      expect(html).toContain(`for="${id}"`); expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('value="lead" selected=""'); expect(html).toContain("Source fictive"); expect(html).toContain("Bonjour, modèle fictif sans signature.");
  });
  it.each(["charly", "elio"])("keeps the %s extension form free of SAV fields", agentKey => {
    const html = renderToStaticMarkup(createElement(ContentForm, { defaults: { agentKey, ownerEmail: "staff@example.invalid" } }));
    expect(html).not.toContain('name="savResolution"'); expect(html).not.toContain('name="savResponseTemplate"');
  });
  it("keeps onboarding fields and does not show a support response template", () => {
    const html = renderToStaticMarkup(createElement(ContentForm, { defaults: { agentKey: "sav", type: "onboarding", ownerEmail: "staff@example.invalid" } }));
    expect(html).toContain('name="actionSteps"'); expect(html).not.toContain('name="savResponseTemplate"');
  });
});
