import { accessSkillWireAnswer } from "../src/lib/sav/cases/access-skill/access-skill-wire";

/*
 * Chantier « 3 blocs » test double of the model behind the two-stage entry: it answers at the network boundary only (the real wire, key resolution,
 * transport bounds, V2 spend gate, store and pure rules run). It tells the calls apart by their system instruction: the router, Access's SAV-97 judge,
 * a block's confirmation (by block id) and the shared counter-read. Synthetic values only.
 */

export type EntryDoubleCall = { kind: "router" | "access_judge" | "judge" | "counter"; blockId: string | null;
  payload: { purpose: string; subject: string; text: string; requests?: Array<{ requestId: string; kind: string; words: string | null }> } };
export type EntryDoubleAnswer = { output: unknown } | { http: number } | { lost: true };

export function entrySkillModelDouble(script: (call: EntryDoubleCall) => EntryDoubleAnswer) {
  const calls: EntryDoubleCall[] = [];
  const network = async (url: string, init: RequestInit) => {
    if (!/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/synthetic-model:generateContent$/.test(url)) throw Error(`UNEXPECTED_URL ${url}`);
    const body = JSON.parse(String(init.body)) as { systemInstruction: { parts: Array<{ text: string }> }; contents: Array<{ parts: Array<{ text: string }> }> };
    const prompt = body.systemInstruction.parts[0]!.text, block = /^COMPÉTENCE D'ENTRÉE « [^»]+ » \(bloc "([a-z0-9_]+)"\)/.exec(prompt);
    const kind = prompt.startsWith("TRI D'ENTRÉE") ? "router" as const : prompt.startsWith("CONTRE-LECTURE") ? "counter" as const : block ? "judge" as const : "access_judge" as const;
    const call: EntryDoubleCall = { kind, blockId: block?.[1] ?? null, payload: JSON.parse(body.contents[0]!.parts[0]!.text) };
    calls.push(call);
    const answer = script(call);
    if ("lost" in answer) throw Error("SYNTHETIC_CONNECTION_LOST");
    if ("http" in answer) return new Response("{}", { status: answer.http });
    return new Response(JSON.stringify(accessSkillWireAnswer(answer.output)), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { network, calls };
}

/** The router's answer: one route per request (in order), and the mail-level sensitivity. */
export const routerSays = (routes: Array<[requestId: string, route: string]>, mailSensitive: "no" | "yes" | "unsure" = "no") =>
  ({ mailSensitive, requests: routes.map(([requestId, route]) => ({ requestId, route, reason: "synthetic" })) });

/** A block confirmation (or Access's judge, with `access` for `block`): one row per request. */
export function confirmSays(rows: Array<{ requestId: string; verdict: string; quote: string; family?: string | null; confidence?: string }>,
  mail: { sensitive?: string; thirdParty?: boolean; instructionLike?: boolean } = {}) {
  return { mail: { sensitive: mail.sensitive ?? "none", thirdParty: mail.thirdParty ?? false, instructionLike: mail.instructionLike ?? false },
    requests: rows.map(row => ({ requestId: row.requestId, verdict: row.verdict, family: row.family ?? (row.verdict === "sensitive" ? "finance" : null), confidence: row.confidence ?? "high", quote: row.quote, reason: "synthetic" })),
    sensitiveMentions: [] };
}
export const counterSaysNo = () => ({ asksOrContestsSensitive: "no", families: [], quote: null, reason: "synthetic" });
export const counterSaysYes = () => ({ asksOrContestsSensitive: "yes", families: ["finance"], quote: null, reason: "synthetic" });
