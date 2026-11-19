import { accessSkillWireBody, boundAccessSkillInput, type AccessSkillInput } from "../cases/access-skill/access-skill-wire";

/*
 * The wire of the two-stage entry's calls, PURE, on the SAME envelope as the Access skill (`access-skill-wire.ts`): system instruction, the customer data
 * as a JSON user part (bounded exactly like Access: subject 500, text 12 000, 8 requests, words 1 000), JSON output, temperature 0. The shared
 * counter-read IS Access's counter-read body, byte for byte (`accessSkillWireBody("counter", ...)`).
 */

export type EntrySkillInput = AccessSkillInput;
export type EntryCallKind = "router" | "confirm" | "counter";

export function entryWireBody(kind: EntryCallKind, systemPrompt: string, input: EntrySkillInput, maxOutputTokens: number): string {
  if (kind === "counter") return accessSkillWireBody("counter", input, maxOutputTokens);
  return JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: JSON.stringify(boundAccessSkillInput(input)) }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens },
  });
}
