import { describe, expect, it } from "vitest";
import { embeddingApiKey, embeddingFailureDiagnostic } from "./embeddings";

describe("embedding credential isolation", () => {
  it("uses only the SAV identity for SAV embeddings", () => {
    expect(embeddingApiKey("sav", {
      SAV_GEMINI_API_KEY: "sav-key",
      KNOWLEDGE_GEMINI_API_KEY: "knowledge-key",
      EXTENSION_GEMINI_API_KEY: "extension-key",
      GEMINI_API_KEY: "legacy-key",
    })).toBe("sav-key");
  });

  it("never falls back to an extension or legacy key for SAV", () => {
    expect(embeddingApiKey("sav", {
      KNOWLEDGE_GEMINI_API_KEY: "knowledge-key",
      EXTENSION_GEMINI_API_KEY: "extension-key",
      GEMINI_API_KEY: "legacy-key",
    })).toBe("");
  });

  it("keeps the legacy fallback only for extension knowledge during migration", () => {
    expect(embeddingApiKey("extension", { GEMINI_API_KEY: "legacy-key" })).toBe("legacy-key");
  });

  it("produit un diagnostic fournisseur sans contenu ni clé", () => {
    const diagnostic = embeddingFailureDiagnostic({ status: 403, code: "API_KEY_INVALID", secret: "never-log" }, 42.4);
    expect(diagnostic).toEqual({ model: "gemini-embedding-001", status: 403, errorCode: "API_KEY_INVALID", latencyMs: 42 });
    expect(JSON.stringify(diagnostic)).not.toContain("never-log");
  });

  it("extrait le code Google sans retourner le message fournisseur", () => {
    const diagnostic = embeddingFailureDiagnostic({
      name: "ApiError",
      status: 400,
      message: JSON.stringify({ error: { code: 400, status: "API_KEY_SERVICE_BLOCKED", message: "sensitive provider detail" } }),
    }, 12.4);
    expect(diagnostic).toEqual({ model: "gemini-embedding-001", status: 400, errorCode: "API_KEY_SERVICE_BLOCKED", latencyMs: 12 });
    expect(JSON.stringify(diagnostic)).not.toContain("sensitive provider detail");
  });
});
