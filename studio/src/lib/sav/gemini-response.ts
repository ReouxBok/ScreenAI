import { z } from "zod";

const finishReasons = [
  "FINISH_REASON_UNSPECIFIED", "STOP", "MAX_TOKENS", "SAFETY", "RECITATION", "LANGUAGE", "OTHER",
  "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "MALFORMED_FUNCTION_CALL", "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT", "IMAGE_OTHER", "NO_IMAGE", "IMAGE_RECITATION", "UNEXPECTED_TOOL_CALL",
  "TOO_MANY_TOOL_CALLS", "MISSING_THOUGHT_SIGNATURE", "MALFORMED_RESPONSE", "ESCALATION", "PUP_LIMITED_DISABLED",
] as const;
const blockReasons = ["BLOCK_REASON_UNSPECIFIED", "SAFETY", "OTHER", "BLOCKLIST", "PROHIBITED_CONTENT", "IMAGE_SAFETY"] as const;
const tokenCount = z.number().int().min(0).max(2_147_483_647).optional();
const responseSchema = z.object({
  candidates: z.array(z.object({
    finishReason: z.string().optional(),
    content: z.object({ parts: z.array(z.object({ text: z.string().optional(), thought: z.boolean().optional() })).optional() }).optional(),
  })).optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  usageMetadata: z.object({
    promptTokenCount: tokenCount, candidatesTokenCount: tokenCount,
    thoughtsTokenCount: tokenCount, totalTokenCount: tokenCount,
  }).optional(),
});

// Only these allowlisted enums and numeric counters may enter logs or run traces.
// Provider messages, text, thought summaries and signatures remain transient.
export type SavGeminiMetadata = {
  finishReason?: typeof finishReasons[number] | "UNKNOWN";
  blockReason?: typeof blockReasons[number] | "UNKNOWN";
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
};

export function readSavGeminiResponse(payload: unknown) {
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success) throw new Error("SAV_AI_INVALID_RESPONSE");
  const candidate = parsed.data.candidates?.[0];
  const finishReason = candidate?.finishReason;
  const blockReason = parsed.data.promptFeedback?.blockReason;
  const usage = parsed.data.usageMetadata;
  const metadata: SavGeminiMetadata = {
    finishReason: finishReason === undefined ? undefined : finishReasons.find((value) => value === finishReason) ?? "UNKNOWN",
    blockReason: blockReason === undefined ? undefined : blockReasons.find((value) => value === blockReason) ?? "UNKNOWN",
    inputTokens: usage?.promptTokenCount, outputTokens: usage?.candidatesTokenCount,
    thoughtTokens: usage?.thoughtsTokenCount, totalTokens: usage?.totalTokenCount,
  };
  const text = candidate?.content?.parts?.filter((part) => !part.thought).map((part) => part.text ?? "").join("").trim() ?? "";
  return { metadata, text };
}

export function parseSavGeminiJson(response: ReturnType<typeof readSavGeminiResponse>): unknown {
  const { metadata, text } = response;
  if (metadata.blockReason && metadata.blockReason !== "BLOCK_REASON_UNSPECIFIED") throw new Error("SAV_AI_OUTPUT_BLOCKED");
  if (metadata.finishReason === "MAX_TOKENS") throw new Error("SAV_AI_OUTPUT_TRUNCATED");
  if (["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION", "ESCALATION", "PUP_LIMITED_DISABLED"].some((reason) => reason === metadata.finishReason)) {
    throw new Error("SAV_AI_OUTPUT_BLOCKED");
  }
  if (metadata.finishReason && metadata.finishReason !== "STOP") throw new Error("SAV_AI_OUTPUT_INCOMPLETE");
  if (!text) throw new Error("SAV_AI_EMPTY_OUTPUT");
  // Accept one complete JSON fence, never extract a fragment or repair a truncated object.
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(text);
  try { return JSON.parse(fenced ? fenced[1] : text); }
  catch { throw new Error("SAV_AI_INVALID_JSON"); }
}
