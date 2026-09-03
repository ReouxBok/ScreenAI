import "server-only";

import { GoogleGenAI } from "@google/genai";

const DIMENSIONS = 768;
export const GEMINI_EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL ?? "gemini-embedding-001";
export type EmbeddingScope = "extension" | "sav";

type EmbeddingEnvironment = Record<string, string | undefined>;

export function embeddingApiKey(scope: EmbeddingScope, env: EmbeddingEnvironment = process.env) {
  if (scope === "sav") return env.SAV_GEMINI_API_KEY || "";
  return env.KNOWLEDGE_GEMINI_API_KEY || env.EXTENSION_GEMINI_API_KEY || env.GEMINI_API_KEY || "";
}

export function deterministicEmbedding(text: string) {
  const values = new Array<number>(DIMENSIONS).fill(0);
  const words = text.toLocaleLowerCase("fr").match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const word of words) {
    let hash = 2166136261;
    for (let index = 0; index < word.length; index += 1) {
      hash ^= word.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    values[Math.abs(hash) % DIMENSIONS] += hash % 2 ? 1 : -1;
  }
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map((value) => value / norm);
}

export function embeddingFailureDiagnostic(error: unknown, durationMs: number, model = GEMINI_EMBEDDING_MODEL) {
  const source = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const status = Number(source.status ?? source.statusCode);
  let providerCode: unknown;
  if (typeof source.message === "string") {
    try {
      const parsed = JSON.parse(source.message) as { error?: { status?: unknown; code?: unknown } };
      providerCode = parsed.error?.status ?? parsed.error?.code;
    } catch {
      providerCode = undefined;
    }
  }
  const rawCode = String(source.code ?? providerCode ?? source.name ?? "EMBEDDING_PROVIDER_ERROR");
  return {
    model,
    status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    errorCode: rawCode.replace(/[^A-Z0-9_.:-]/gi, "_").slice(0, 100),
    latencyMs: Math.max(0, Math.round(durationMs)),
  };
}

export async function embedTexts(
  texts: string[],
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY",
  options: { scope?: EmbeddingScope; apiKey?: string } = {},
) {
  const apiKey = options.apiKey || embeddingApiKey(options.scope ?? "extension");
  if (!apiKey) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(options.scope === "sav" ? "SAV_GEMINI_API_KEY_MISSING" : "KNOWLEDGE_GEMINI_API_KEY_MISSING");
    }
    return texts.map(deterministicEmbedding);
  }

  const model = process.env.GEMINI_EMBEDDING_MODEL ?? "gemini-embedding-001";
  const startedAt = performance.now();
  let response;
  try {
    const client = new GoogleGenAI({ apiKey });
    response = await client.models.embedContent({
      model,
      contents: texts,
      config: { taskType, outputDimensionality: DIMENSIONS },
    });
  } catch (error) {
    console.error("embedding_provider_error", {
      scope: options.scope ?? "extension",
      ...embeddingFailureDiagnostic(error, performance.now() - startedAt, model),
    });
    throw error;
  }
  const embeddings = response.embeddings ?? [];
  if (embeddings.length !== texts.length) throw new Error("EMBEDDING_COUNT_MISMATCH");
  return embeddings.map((embedding) => {
    if (!embedding.values || embedding.values.length !== DIMENSIONS) throw new Error("INVALID_EMBEDDING");
    return embedding.values;
  });
}

export async function probeEmbedding(scope: EmbeddingScope = "extension") {
  const startedAt = performance.now();
  await embedTexts(["diagnostic technique sans donnée client"], "RETRIEVAL_QUERY", { scope });
  return { model: process.env.GEMINI_EMBEDDING_MODEL ?? "gemini-embedding-001", status: 200, latencyMs: Math.round(performance.now() - startedAt) };
}
