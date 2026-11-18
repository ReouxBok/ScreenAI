import { createHash } from "node:crypto";
import { z } from "zod";
import { accessSkillCounterReadPrompt, accessSkillJudgePrompt } from "./access-skill-guidelines";

/*
 * SAV-97: the wire of the two Access skill calls on Gemini `generateContent`, PURE (no network, key, database or clock), shared by the production
 * transport (`access-skill-judge.ts`, behind the V2 spend gate) and the operator's real-model evaluation script, so both send the very same body.
 * Same envelope as V2's decision call (`caseGeminiDecisionBody`): system instruction, the customer data as a JSON user part, JSON output, temperature 0.
 */

export const SAV_ACCESS_SKILL_GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
export type AccessSkillCallKind = "judge" | "counter";
/** The input of both calls. Customer texts are DATA (the prompts say so); bounded so a huge mail cannot grow the call. */
export type AccessSkillInput = Readonly<{
  purpose: "first_mail" | "return";
  subject: string; text: string;
  originalRequest: Readonly<{ subject: string; text: string }> | null;
  /** The requests to decide: V1's (id, V1 kind, the customer's verified words when V1 had several) or the return's open requests. */
  requests: ReadonlyArray<Readonly<{ requestId: string; kind: string; words: string | null }>>;
}>;
const TEXT_MAX = 12_000, SUBJECT_MAX = 500, WORDS_MAX = 1_000;
export function boundAccessSkillInput(input: AccessSkillInput): AccessSkillInput {
  return {
    purpose: input.purpose, subject: input.subject.slice(0, SUBJECT_MAX), text: input.text.slice(0, TEXT_MAX),
    originalRequest: input.originalRequest ? { subject: input.originalRequest.subject.slice(0, SUBJECT_MAX), text: input.originalRequest.text.slice(0, TEXT_MAX) } : null,
    requests: input.requests.slice(0, 8).map(row => ({ requestId: row.requestId, kind: row.kind, words: row.words === null ? null : row.words.slice(0, WORDS_MAX) })),
  };
}
/** The hash a stored reading is bound to: the same bounded input read again must give the same hash, or the reading is not this mail's. */
export const accessSkillInputHash = (input: AccessSkillInput) => createHash("sha256").update(JSON.stringify(boundAccessSkillInput(input))).digest("hex");

/** The exact body sent for one call. The counter-read sees the same mail but not the judge's answer (independent reading). */
export function accessSkillWireBody(kind: AccessSkillCallKind, input: AccessSkillInput, maxOutputTokens: number): string {
  const bounded = boundAccessSkillInput(input);
  const payload = kind === "judge" ? bounded : { purpose: bounded.purpose, subject: bounded.subject, text: bounded.text, originalRequest: bounded.originalRequest };
  return JSON.stringify({
    systemInstruction: { parts: [{ text: kind === "judge" ? accessSkillJudgePrompt() : accessSkillCounterReadPrompt() }] },
    contents: [{ role: "user", parts: [{ text: JSON.stringify(payload) }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens },
  });
}

const envelope = z.object({
  candidates: z.array(z.object({ content: z.object({ parts: z.array(z.object({ text: z.string().optional() }).passthrough()) }).passthrough().optional(), finishReason: z.string().optional() }).passthrough()).optional(),
  usageMetadata: z.object({ promptTokenCount: z.number().optional(), candidatesTokenCount: z.number().optional(), thoughtsTokenCount: z.number().optional() }).passthrough().optional(),
}).passthrough();
export type AccessSkillUsage = Readonly<{ inputTokens: number; outputTokens: number }>;
export type AccessSkillWireResult = Readonly<{ status: "ok"; output: unknown; usage: AccessSkillUsage | null }> | Readonly<{ status: "failed"; problem: string; uncertain: boolean; usage: AccessSkillUsage | null }>;

/** Reads a 2xx Gemini answer: the JSON the model wrote, or a closed failure code. The provider's text is never logged. */
export function readAccessSkillWireResponse(json: unknown): AccessSkillWireResult {
  const parsed = envelope.safeParse(json);
  if (!parsed.success) return { status: "failed", problem: "envelope_invalid", uncertain: true, usage: null };
  const meta = parsed.data.usageMetadata, int = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
  const usage = meta && int(meta.promptTokenCount) && int(meta.candidatesTokenCount) && (meta.thoughtsTokenCount === undefined || int(meta.thoughtsTokenCount))
    ? { inputTokens: meta.promptTokenCount!, outputTokens: meta.candidatesTokenCount! + (meta.thoughtsTokenCount ?? 0) } : null;
  const candidate = parsed.data.candidates?.[0], text = candidate?.content?.parts.map(part => part.text ?? "").join("") ?? "";
  if (candidate?.finishReason && candidate.finishReason !== "STOP") return { status: "failed", problem: "finish_not_stop", uncertain: false, usage };
  if (!text.trim()) return { status: "failed", problem: "empty_response", uncertain: false, usage };
  try { return { status: "ok", output: JSON.parse(text) as unknown, usage }; } catch { return { status: "failed", problem: "output_json_invalid", uncertain: false, usage }; }
}

/** A Gemini-shaped answer carrying `output` (tests, the model double and the dry-run script). */
export function accessSkillWireAnswer(output: unknown, usage: AccessSkillUsage = { inputTokens: 1_000, outputTokens: 200 }) {
  return { candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: usage.inputTokens, candidatesTokenCount: usage.outputTokens } };
}
