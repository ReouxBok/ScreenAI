import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SAV_PRODUCT_GUIDANCE } from "./product-guidance";

describe("shared SAV product guidance", () => {
  it("requires reviewed evidence and respects the customer's product and need", () => {
    expect(SAV_PRODUCT_GUIDANCE).toContain("Limova 3");
    expect(SAV_PRODUCT_GUIDANCE).toContain("fiches SAV validées");
    expect(SAV_PRODUCT_GUIDANCE).toContain("au produit et au contexte du client");
  });
  it("is used by both model runtimes without embedding imported procedures", async () => {
    const [legacy, adk] = await Promise.all([readFile(new URL("./intelligence.ts", import.meta.url), "utf8"), readFile(new URL("./agent/orchestrator.ts", import.meta.url), "utf8")]);
    expect(legacy).toContain('text: SAV_PRODUCT_GUIDANCE +');
    expect(adk).toContain('${SAV_PRODUCT_GUIDANCE}');
  });
});
