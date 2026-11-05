import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { savCases, savMessages } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { readSavAgentPause } from "../intake/agent-pause";
import { createSavKnowledgeVectorIndex, SAV_RETRIEVAL_EMBEDDING_DIMENSION } from "../request-retrieval-db";
import type { CaseOwnerReadTransport } from "./admission-owner-reader";
import type { SourceRef } from "./case-types";
import { caseResolutionCheckSchema } from "./investigation-closure";
import { caseDecisionProposalSchema } from "./decision-contract";
import type { CaseEmbeddingTransport, CaseKnowledgeVectorSearch } from "./investigation-budgeted-retrieval";
import type { CaseInvestigationModelRequest, CaseInvestigationPauseLevel } from "./investigation-runner";
import type { CaseV2ModelTransport } from "./investigation-v2-spend";

/*
 * B (4/11, LOCAL and OFF): the real adapters of the V2 investigation. Each talks to its provider through an injected `network` (`fetch` by
 * default), so a test replaces the network and nothing else. Keys and models are read from the environment at each call, never cached,
 * never defaulted; V2 has its own key (`SAV_V2_GEMINI_API_KEY`), never V1's. No SDK, no retry here: a call is sent at most once (the
 * ledger and the spend register decide), and an error body is never read nor logged.
 */

type Env = Readonly<Record<string, string | undefined>>;
export type CaseV2Network = (url: string, init: RequestInit) => Promise<Response>;
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/models";
export const SAV_V2_GEMINI_KEY_ENV = "SAV_V2_GEMINI_API_KEY";
export const SAV_V2_EMBEDDING_MODEL_ENV = "SAV_V2_EMBEDDING_MODEL";
export const SAV_V2_MODEL_ENV = "SAV_V2_MODEL";
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,99}$/;

/** What the V2 provider configuration lacks, by precise code; empty when keys and models are set (their values are never returned). */
export function caseV2ProviderConfigProblems(env: Env): string[] {
  const problems: string[] = [];
  if (!env[SAV_V2_GEMINI_KEY_ENV]?.trim()) problems.push("v2_gemini_key_absent");
  if (!MODEL_ID.test(env[SAV_V2_EMBEDDING_MODEL_ENV] ?? "")) problems.push("v2_embedding_model_absent");
  if (!MODEL_ID.test(env[SAV_V2_MODEL_ENV] ?? "")) problems.push("v2_model_absent");
  return problems;
}

/** The SAV vector index V2 already has (`createSavKnowledgeVectorIndex`), as the budgeted search's port; built at each call with the clock now. */
export function caseKnowledgeVectorSearch(options: Readonly<{ locale: string; audience: "support" | "lead"; now: () => Date }>): CaseKnowledgeVectorSearch {
  const index = () => createSavKnowledgeVectorIndex({ locale: options.locale, audience: options.audience, now: options.now() });
  return {
    dimension: SAV_RETRIEVAL_EMBEDDING_DIMENSION,
    readRevision: () => index().readRevision(),
    available: () => index().available(),
    search: (queries, vectors, limit) => index().searchByVectors(queries, vectors, limit),
  };
}

const embedResponse = z.object({ embeddings: z.array(z.object({ values: z.array(z.number()) })) });
/** Gemini `batchEmbedContents` (REST), query task, the index dimension. The provider reports no usage here: the register keeps the reservation. */
export function caseGeminiEmbeddingTransport(input: Readonly<{ env: () => Env; network?: CaseV2Network; dimension?: number }>): CaseEmbeddingTransport {
  const network = input.network ?? ((url, init) => fetch(url, init));
  const dimension = input.dimension ?? SAV_RETRIEVAL_EMBEDDING_DIMENSION;
  return async ({ texts, signal }) => {
    const env = input.env(), key = env[SAV_V2_GEMINI_KEY_ENV]?.trim(), model = env[SAV_V2_EMBEDDING_MODEL_ENV] ?? "";
    if (!key) throw Error("SAV_V2_GEMINI_KEY_ABSENT");
    if (!MODEL_ID.test(model)) throw Error("SAV_V2_EMBEDDING_MODEL_ABSENT");
    const response = await network(`${GEMINI}/${encodeURIComponent(model)}:batchEmbedContents`, {
      method: "POST", signal, headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ requests: texts.map(text => ({ model: `models/${model}`, content: { parts: [{ text }] }, taskType: "RETRIEVAL_QUERY", outputDimensionality: dimension })) }),
    });
    if (!response.ok) { await response.body?.cancel(); throw Error(`SAV_V2_EMBEDDING_HTTP_${response.status}`); }
    const parsed = embedResponse.safeParse(await response.json());
    if (!parsed.success || parsed.data.embeddings.length !== texts.length || parsed.data.embeddings.some(row => row.values.length !== dimension))
      throw Error("SAV_V2_EMBEDDING_INVALID_RESPONSE");
    return { vectors: parsed.data.embeddings.map(row => row.values), usage: null };
  };
}

export const SAV_CASE_INVESTIGATION_PROMPT_REVISION = "sav-v2-investigation-prompt-2026-11-05.v3";
const CLOSURE_JSON_SCHEMA = JSON.stringify(z.toJSONSchema(caseResolutionCheckSchema));
const DECISION_JSON_SCHEMA = JSON.stringify(z.toJSONSchema(caseDecisionProposalSchema, { io: "input", unrepresentable: "any" }));
/**
 * The decision prompt: the contract (the proposal's JSON schema, the one the validator applies), the case as stored (open requests, facts,
 * questions, trials), the cards retrieved for it and the previous rejections. Nothing is decided here; the validator judges the answer.
 */
export function caseInvestigationPrompt(request: CaseInvestigationModelRequest) {
  const body = request.snapshot.body;
  const cards = request.knowledge.map(card => ({ knowledgeId: card.id, contentVersionId: card.contentVersionId, title: card.title,
    content: card.content.slice(0, 6_000), resolution: card.resolution }));
  const instruction = [
    "Tu es l'agent SAV V2 de Limova. Tu proposes UNE décision pour ce dossier, en JSON strictement conforme au schéma fourni.",
    "Réponds en français, uniquement à partir des fiches fournies (citer knowledgeId et contentVersionId exacts) et des faits du dossier.",
    "N'invente ni lien, ni état de compte, ni paiement, ni droit. Ne demande jamais de mot de passe ni de code. Si les fiches ne suffisent pas, pose une question ciblée ou transmets à l'équipe.",
    ...(request.customerReportedLogin ? ["customerReportedLogin résume les déclarations du client sur la connexion. Un indicateur false signifie non établi. Tiens compte des contrôles confirmés sans les redemander. restoredAccessReported contient la citation et sa source si le dernier mail confirme explicitement le rétablissement. Cite-les pour proposer confirm_resolution si la chronologie le permet. stillBlockedReported demande de poursuivre le diagnostic. Une seconde lecture distincte doit confirmer toute clôture."] : []),
    request.purpose === "resolution_check" ? "Objet : vérifier si les demandes listées dans « closure » sont résolues, d'après les mots du client cités." : "Objet : la prochaine action sur les demandes ouvertes.",
    `Le champ caseVersion vaut ${request.snapshot.version}.`,
  ].join("\n");
  const payload = { caseVersion: request.snapshot.version, purpose: request.purpose,
    openRequests: body.openRequests.filter(row => row.status === "open"), facts: body.facts, questions: body.questions, trials: body.trials,
    ...(request.customerReportedLogin ? { customerReportedLogin: request.customerReportedLogin } : {}),
    knowledge: cards, coverage: request.coverage, previousRejections: request.feedback, closure: request.closure };
  return { instruction, schema: request.purpose === "resolution_check" ? CLOSURE_JSON_SCHEMA : DECISION_JSON_SCHEMA, payload };
}

const generateResponse = z.object({
  candidates: z.array(z.object({ content: z.object({ parts: z.array(z.object({ text: z.string().optional() }).passthrough()) }).passthrough().optional(), finishReason: z.string().optional() }).passthrough()).optional(),
  usageMetadata: z.object({ promptTokenCount: z.number().optional(), candidatesTokenCount: z.number().optional(), thoughtsTokenCount: z.number().optional() }).passthrough().optional(),
}).passthrough();

/**
 * Gemini `generateContent` (REST) as the runner's provider, sent once. A refusal before processing (4xx but 408/429) is a failure that
 * consumed nothing; 408, 429, 5xx, a timeout or a lost connection are uncertain (verified, never resent); an answer that is not JSON is a
 * failure whose usage is still reported.
 */
export function caseGeminiDecisionProvider(input: Readonly<{ env: () => Env; network?: CaseV2Network; timeoutMs?: number }>): CaseV2ModelTransport {
  const network = input.network ?? ((url, init) => fetch(url, init));
  return async request => {
    const env = input.env(), key = env[SAV_V2_GEMINI_KEY_ENV]?.trim(), model = env[SAV_V2_MODEL_ENV] ?? "";
    if (!key || !MODEL_ID.test(model)) return { result: { status: "failed", uncertain: false }, usage: { inputTokens: 0, outputTokens: 0 } };
    const prompt = caseInvestigationPrompt(request);
    let response: Response;
    try {
      response = await network(`${GEMINI}/${encodeURIComponent(model)}:generateContent`, {
        method: "POST", signal: AbortSignal.timeout(input.timeoutMs ?? 60_000), headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: `${prompt.instruction}\n\nSchéma JSON de la réponse :\n${prompt.schema}` }] },
          contents: [{ role: "user", parts: [{ text: JSON.stringify(prompt.payload) }] }], generationConfig: { responseMimeType: "application/json", temperature: 0 } }),
      });
    } catch { return { result: { status: "failed", uncertain: true }, usage: null }; }
    if (!response.ok) {
      await response.body?.cancel();
      const unprocessed = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
      return { result: { status: "failed", uncertain: !unprocessed }, usage: unprocessed ? { inputTokens: 0, outputTokens: 0 } : null };
    }
    let parsed: z.infer<typeof generateResponse>;
    try { parsed = generateResponse.parse(await response.json()); } catch { return { result: { status: "failed", uncertain: true }, usage: null }; }
    const meta = parsed.usageMetadata;
    const usage = meta && typeof meta.promptTokenCount === "number" ? { inputTokens: meta.promptTokenCount, outputTokens: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0) } : null;
    const candidate = parsed.candidates?.[0];
    const text = candidate?.content?.parts.map(part => part.text ?? "").join("") ?? "";
    if (!text.trim() || (candidate?.finishReason && candidate.finishReason !== "STOP")) return { result: { status: "failed", uncertain: false }, usage };
    try { return { result: { status: "ok", output: JSON.parse(text) as unknown }, usage }; } catch { return { result: { status: "failed", uncertain: false }, usage }; }
  };
}

/** `customerTexts`: the decrypted own text of the case's stored inbound mails named by these refs (`email:<Gmail id>`); an unreadable one is absent. */
export function caseCustomerTextsReader() {
  return async (caseId: string, refs: SourceRef[]): Promise<Record<string, string>> => {
    const ids = [...new Set(refs.filter(ref => ref.type === "email").map(ref => ref.id))];
    if (!ids.length) return {};
    const db = requireDb();
    const [owner] = await db.select({ threadIds: savCases.threadIds }).from(savCases).where(eq(savCases.id, caseId));
    if (!owner?.threadIds.length) return {};
    const rows = await db.select({ gmail: savMessages.gmailMessageId, body: savMessages.bodyCiphertext }).from(savMessages)
      .where(and(eq(savMessages.direction, "inbound"), inArray(savMessages.threadId, owner.threadIds), inArray(savMessages.gmailMessageId, ids)));
    const texts: Record<string, string> = {};
    for (const row of rows) {
      try { const body = decryptSavPayload<{ text?: unknown }>(row.body); if (row.gmail && typeof body.text === "string") texts[`email:${row.gmail}`] = body.text; } catch { /* unreadable: absent */ }
    }
    return texts;
  };
}

/** A GET-only HubSpot transport for the owner read: token read at each request, never logged; a non-2xx or a network error throws. */
export function caseHubspotOwnerReadTransport(input: Readonly<{ env: () => Env; network?: CaseV2Network }>): CaseOwnerReadTransport {
  const network = input.network ?? ((url, init) => fetch(url, init));
  return async request => {
    if (request.method !== "GET" || !/^\/crm\/v3\/objects\/tickets\/\d{1,30}\?properties=hubspot_owner_id$/.test(request.path)) throw Error("SAV_V2_OWNER_READ_PATH_INVALID");
    const token = input.env().HUBSPOT_ACCESS_TOKEN?.trim();
    if (!token) throw Error("SAV_V2_HUBSPOT_TOKEN_ABSENT");
    const response = await network(`https://api.hubapi.com${request.path}`, { method: "GET", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) { await response.body?.cancel(); throw Error(`SAV_V2_OWNER_READ_HTTP_${response.status}`); }
    return response.json();
  };
}

/** `pauseState`: the existing global pause, agent `v2`; an unreadable or invalid setting is a full stop. */
export function caseV2PauseState() {
  return async (): Promise<CaseInvestigationPauseLevel> => {
    try {
      const state = await readSavAgentPause(requireDb(), "v2");
      return state.invalid ? "fully_paused" : state.level;
    } catch { return "fully_paused"; }
  };
}
