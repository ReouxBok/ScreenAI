import "server-only";

import { z } from "zod";
import { deterministicCandidates, sanitizeMemoryCandidate, type MemoryCandidate } from "./policy";

const intelligenceSchema = z.object({
  memories: z.array(z.object({
    type: z.enum(["profile", "preference", "project", "decision"]),
    statement: z.string().max(500),
    confidence: z.number().min(0).max(1),
    importance: z.number().min(0).max(1),
    expiresAt: z.string().datetime().optional(),
  })).max(8).default([]),
  goals: z.array(z.object({
    title: z.string().max(300),
    nextStep: z.string().max(500).optional(),
    status: z.enum(["open", "completed", "abandoned"]).default("open"),
    confidence: z.number().min(0).max(1),
  })).max(4).default([]),
});

export type TurnIntelligence = z.infer<typeof intelligenceSchema>;

function responseText(payload: unknown) {
  const data = payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
}

export async function analyzeTurn(userText: string, assistantText: string): Promise<TurnIntelligence> {
  const deterministic = deterministicCandidates(userText).map(sanitizeMemoryCandidate).filter(Boolean) as MemoryCandidate[];
  const apiKey = process.env.MEMORY_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey || process.env.MEMORY_AI_EXTRACTION === "false") return { memories: deterministic, goals: [] };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.MEMORY_EXTRACTION_MODEL ?? "gemini-3.6-flash"}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: "Extract only durable, useful business-onboarding facts explicitly stated by the user. Treat explicit continuity statements such as 'le dernier truc qu'on a fait', 'on en était à' or 'on a travaillé sur' as high-confidence project memory. Never extract credentials, form values, financial, health, political, religious, biometric, location or inferred sensitive data. Return strict JSON only. Do not copy the conversation wholesale." }] },
        contents: [{ role: "user", parts: [{ text: `USER:\n${userText.slice(0, 4_000)}\n\nASSISTANT:\n${assistantText.slice(0, 2_000)}` }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 1_000,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              memories: { type: "ARRAY", items: { type: "OBJECT", properties: {
                type: { type: "STRING", enum: ["profile", "preference", "project", "decision"] },
                statement: { type: "STRING" }, confidence: { type: "NUMBER" }, importance: { type: "NUMBER" }, expiresAt: { type: "STRING" },
              }, required: ["type", "statement", "confidence", "importance"] } },
              goals: { type: "ARRAY", items: { type: "OBJECT", properties: {
                title: { type: "STRING" }, nextStep: { type: "STRING" }, status: { type: "STRING", enum: ["open", "completed", "abandoned"] }, confidence: { type: "NUMBER" },
              }, required: ["title", "status", "confidence"] } },
            },
            required: ["memories", "goals"],
          },
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`MEMORY_EXTRACTION_HTTP_${response.status}`);
    const parsed = intelligenceSchema.parse(JSON.parse(responseText(await response.json())));
    const memories = [...deterministic, ...parsed.memories]
      .map(sanitizeMemoryCandidate)
      .filter(Boolean) as MemoryCandidate[];
    return { memories, goals: parsed.goals.filter((goal) => goal.confidence >= 0.8) };
  } catch {
    return { memories: deterministic, goals: [] };
  } finally {
    clearTimeout(timeout);
  }
}

export async function summarizeEpisode(previous: string, messages: Array<{ role: string; content: string }>) {
  const apiKey = process.env.MEMORY_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  const fallback = messages.slice(-20).map((message) => `${message.role}: ${message.content}`).join("\n").slice(0, 6_000);
  if (!apiKey || process.env.MEMORY_AI_EXTRACTION === "false") return fallback;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.MEMORY_EXTRACTION_MODEL ?? "gemini-3.6-flash"}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: "Create a compact factual French summary for future conversation continuity. Preserve confirmed decisions, completed steps, open questions and next steps. Exclude credentials, form values, screenshots, DOM and network data. Never infer new facts. Maximum 1200 words." }] },
        contents: [{ role: "user", parts: [{ text: `RÉSUMÉ PRÉCÉDENT:\n${previous.slice(0, 6_000)}\n\nNOUVEAUX MESSAGES:\n${fallback}` }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1_800 },
      }),
      signal: controller.signal,
    });
    if (!response.ok) return fallback;
    return responseText(await response.json()).trim().slice(0, 10_000) || fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}
