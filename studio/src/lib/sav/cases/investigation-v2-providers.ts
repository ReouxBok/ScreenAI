import { compactInvestigationContext, INVESTIGATION_CONTEXT_INSTRUCTION } from "./investigation-context-view";
import { caseModelFinishReason, type CaseModelTransportDiagnostic } from "./investigation-transport-diagnostic";
import { readCaseV2TransportPolicy, assertCaseV2ReservedPolicy } from "./investigation-v2-spend";
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
 * never defaulted. The key is V2's own (`SAV_V2_GEMINI_API_KEY`) unless the approved, non-secret `SAV_V2_GEMINI_KEY_SOURCE=shared_v1`
 * names V1's key (`SAV_GEMINI_API_KEY`) explicitly: no silent fallback either way, an unknown source or both keys at once is refused.
 * The models stay V2's own and every V2 bound, budget and permission still applies. No SDK, no retry here: a call is sent at most once
 * (the ledger and the spend register decide), and an error body is never read nor logged.
 */

type Env = Readonly<Record<string, string | undefined>>;
export type CaseV2Network = (url: string, init: RequestInit) => Promise<Response>;
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/models";
export const SAV_V2_GEMINI_KEY_ENV = "SAV_V2_GEMINI_API_KEY";
/** Non-secret selector of the V2 key. Absent or `dedicated`: V2's own key only. `shared_v1`: V1's key only (approved sharing). */
export const SAV_V2_GEMINI_KEY_SOURCE_ENV = "SAV_V2_GEMINI_KEY_SOURCE";
export const SAV_V1_GEMINI_KEY_ENV = "SAV_GEMINI_API_KEY";
export type CaseV2GeminiKeySource = "dedicated" | "shared_v1";
export type CaseV2GeminiKey =
  | Readonly<{ ok: true; source: CaseV2GeminiKeySource; key: string }>
  | Readonly<{ ok: false; problem: "v2_gemini_key_source_invalid" | "v2_gemini_key_source_conflict" | "v2_gemini_key_absent" | "v2_shared_v1_gemini_key_absent" }>;

/**
 * The key V2 sends, chosen ONLY by the explicit source: `dedicated` never reads V1's key, `shared_v1` never reads V2's. A shared source
 * while a dedicated key is also set is a conflict (which key is meant is not guessed). The key is returned to the transport only.
 */
export function resolveCaseV2GeminiKey(env: Env): CaseV2GeminiKey {
  const raw = env[SAV_V2_GEMINI_KEY_SOURCE_ENV], source = raw === undefined || raw.trim() === "" ? "dedicated" : raw.trim();
  if (source !== "dedicated" && source !== "shared_v1") return { ok: false, problem: "v2_gemini_key_source_invalid" };
  const dedicated = env[SAV_V2_GEMINI_KEY_ENV]?.trim() ?? "";
  if (source === "dedicated") return dedicated ? { ok: true, source, key: dedicated } : { ok: false, problem: "v2_gemini_key_absent" };
  if (dedicated) return { ok: false, problem: "v2_gemini_key_source_conflict" };
  const shared = env[SAV_V1_GEMINI_KEY_ENV]?.trim() ?? "";
  return shared ? { ok: true, source, key: shared } : { ok: false, problem: "v2_shared_v1_gemini_key_absent" };
}

/** Which key source V2 would use and whether it is usable, never the key itself. Not wired to a page yet: available to a later diagnostic. */
export function caseV2GeminiKeyStatus(env: Env): Readonly<{ source: CaseV2GeminiKeySource | "invalid"; usable: boolean; problem: string | null }> {
  const resolved = resolveCaseV2GeminiKey(env);
  if (resolved.ok) return { source: resolved.source, usable: true, problem: null };
  const source = resolved.problem === "v2_gemini_key_source_invalid" ? "invalid" : resolved.problem === "v2_gemini_key_absent" ? "dedicated" : "shared_v1";
  return { source, usable: false, problem: resolved.problem };
}
export const SAV_V2_EMBEDDING_MODEL_ENV = "SAV_V2_EMBEDDING_MODEL";
export const SAV_V2_MODEL_ENV = "SAV_V2_MODEL";
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,99}$/;

/** What the V2 provider configuration lacks, by precise code; empty when keys and models are set (their values are never returned). */
export function caseV2ProviderConfigProblems(env: Env): string[] {
  const problems: string[] = [];
  const key = resolveCaseV2GeminiKey(env);
  if (!key.ok) problems.push(key.problem);
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
    readExact: refs => index().readExact(refs),
  };
}

const embedResponse = z.object({ embeddings: z.array(z.object({ values: z.array(z.number()) })) });
/** Gemini `batchEmbedContents` (REST), query task, the index dimension. The provider reports no usage here: the register keeps the reservation. */
export function caseGeminiEmbeddingTransport(input: Readonly<{ env: () => Env; network?: CaseV2Network; dimension?: number }>): CaseEmbeddingTransport {
  const network = input.network ?? ((url, init) => fetch(url, init));
  const dimension = input.dimension ?? SAV_RETRIEVAL_EMBEDDING_DIMENSION;
  return async ({ texts, signal, reservationId }) => {
    const env = input.env(), resolved = resolveCaseV2GeminiKey(env), model = env[SAV_V2_EMBEDDING_MODEL_ENV] ?? "";
    if (!resolved.ok) throw Error(({ v2_gemini_key_source_invalid: "SAV_V2_GEMINI_KEY_SOURCE_INVALID", v2_gemini_key_source_conflict: "SAV_V2_GEMINI_KEY_SOURCE_CONFLICT",
      v2_gemini_key_absent: "SAV_V2_GEMINI_KEY_ABSENT", v2_shared_v1_gemini_key_absent: "SAV_V2_GEMINI_KEY_ABSENT" } as const)[resolved.problem]);
    const key = resolved.key;
    if (!MODEL_ID.test(model)) throw Error("SAV_V2_EMBEDDING_MODEL_ABSENT");
    const bounds = readCaseV2TransportPolicy(env);
    if (!texts.length || texts.length>bounds.embeddingMaxTexts || texts.some(text=>!text.trim() || Buffer.byteLength(text,"utf8")>bounds.embeddingMaxTextBytes)) throw Error("SAV_V2_EMBEDDING_REQUEST_UNBOUNDED");
    if (!reservationId) throw Error("SAV_V2_EMBEDDING_RESERVATION_REQUIRED");
    await assertCaseV2ReservedPolicy(reservationId,env);
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
    ...(request.temporaryIncidents?.entries.length ? { temporaryIncidents: request.temporaryIncidents } : {}),
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
/** Prepare the EXACT existing prompt/body. No source, fact, instruction or reply rule is removed to fit. */
export function prepareCaseGeminiDecisionRequest(request: CaseInvestigationModelRequest, env: Env):
  | { ok: true; key: string; model: string; body: string; metadata: Pick<CaseModelTransportDiagnostic, "inputBytes" | "maxInputBytes" | "knowledgeCards"> }
  | { ok: false; diagnostic: CaseModelTransportDiagnostic } {
  const resolved = resolveCaseV2GeminiKey(env), model = env[SAV_V2_MODEL_ENV] ?? "";
  if (!resolved.ok) return { ok: false, diagnostic: { stage: "preflight", code: "key_unavailable", networkAttempted: false } };
  if (!MODEL_ID.test(model)) return { ok: false, diagnostic: { stage: "preflight", code: "model_invalid", networkAttempted: false } };
  let bounds: ReturnType<typeof readCaseV2TransportPolicy>;
  try { bounds = readCaseV2TransportPolicy(env); } catch { return { ok: false, diagnostic: { stage: "preflight", code: "policy_invalid", networkAttempted: false } }; }
  const prompt = caseInvestigationPrompt(request);
  const serialize = (payload: unknown, decoding = "") => JSON.stringify({ systemInstruction: { parts: [{ text: `${prompt.instruction}\n\nSchéma JSON de la réponse :\n${prompt.schema}${decoding}` }] },
    contents: [{ role: "user", parts: [{ text: JSON.stringify(payload) }] }], generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: bounds.maxOutputTokens } });
  let body = serialize(prompt.payload);
  // Preserve the original wire format whenever it fits. Only exact, reversible
  // sharing is allowed; measure the ENTIRE candidate, including decoding rules.
  if (Buffer.byteLength(body, "utf8") > bounds.maxInputBytes) {
    const compact = compactInvestigationContext(prompt.payload);
    if (compact) {
      const candidate = serialize(compact, `\n\n${INVESTIGATION_CONTEXT_INSTRUCTION}`);
      if (Buffer.byteLength(candidate, "utf8") < Buffer.byteLength(body, "utf8")) body = candidate;
    }
  }
  const metadata = { inputBytes: Buffer.byteLength(body, "utf8"), maxInputBytes: bounds.maxInputBytes, knowledgeCards: request.knowledge.length };
  if (metadata.inputBytes > bounds.maxInputBytes) return { ok: false, diagnostic: { stage: "preflight", code: "input_too_large", networkAttempted: false, ...metadata } };
  return { ok: true, key: resolved.key, model, body, metadata };
}

/** Runs before money and dispatch; ledger-known/uncertain calls retain their precedence. */
export function caseGeminiDecisionPreflight(env: () => Env) {
  return (request: CaseInvestigationModelRequest): CaseModelTransportDiagnostic | null => {
    const prepared = prepareCaseGeminiDecisionRequest(request, env());
    return prepared.ok ? null : prepared.diagnostic;
  };
}

export function caseGeminiDecisionProvider(input: Readonly<{ env: () => Env; network?: CaseV2Network; timeoutMs?: number }>): CaseV2ModelTransport {
  const network = input.network ?? ((url, init) => fetch(url, init));
  return async request => {
    const failed = (diagnostic: CaseModelTransportDiagnostic, uncertain: boolean, usage: { inputTokens?: number; outputTokens?: number } | null) => {
      // Structured, closed metadata is useful even if the later journal write fails. No raw error/provider response.
      console.warn("sav_v2_model_transport", diagnostic);
      return { result: { status: "failed" as const, uncertain, diagnostic }, usage };
    };
    const prepared = prepareCaseGeminiDecisionRequest(request, input.env());
    if (!prepared.ok) return failed(prepared.diagnostic, false, { inputTokens: 0, outputTokens: 0 });
    const { key, model, body, metadata } = prepared;
    let response: Response;
    try {
      response = await network(`${GEMINI}/${encodeURIComponent(model)}:generateContent`, {
        method: "POST", signal: AbortSignal.timeout(input.timeoutMs ?? 60_000), headers: { "content-type": "application/json", "x-goog-api-key": key }, body,
      });
    } catch { return failed({ stage: "network", code: "network_failed", networkAttempted: true, ...metadata }, true, null); }
    if (!response.ok) {
      await response.body?.cancel();
      const unprocessed = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
      return failed({ stage: "http", code: "http_rejected", networkAttempted: true, httpStatus: response.status, ...metadata }, !unprocessed, unprocessed ? { inputTokens: 0, outputTokens: 0 } : null);
    }
    let parsed: z.infer<typeof generateResponse>;
    try { parsed = generateResponse.parse(await response.json()); } catch { return failed({ stage: "envelope", code: "envelope_invalid", networkAttempted: true, ...metadata }, true, null); }
    const meta = parsed.usageMetadata;
    const usage = meta && Number.isSafeInteger(meta.promptTokenCount) && Number(meta.promptTokenCount)>=0 && Number.isSafeInteger(meta.candidatesTokenCount) && Number(meta.candidatesTokenCount)>=0 && (meta.thoughtsTokenCount===undefined || Number.isSafeInteger(meta.thoughtsTokenCount) && meta.thoughtsTokenCount>=0) ? { inputTokens: meta.promptTokenCount!, outputTokens: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0) } : null;
    const candidate = parsed.candidates?.[0];
    const text = candidate?.content?.parts.map(part => part.text ?? "").join("") ?? "";
    const finish = candidate?.finishReason ? { finishReason: caseModelFinishReason(candidate.finishReason) } : {};
    if (candidate?.finishReason && candidate.finishReason !== "STOP") return failed({ stage: "content", code: "finish_not_stop", networkAttempted: true, ...metadata, ...finish }, false, usage);
    if (!text.trim()) return failed({ stage: "content", code: "empty_response", networkAttempted: true, ...metadata, ...finish }, false, usage);
    try { return { result: { status: "ok", output: JSON.parse(text) as unknown }, usage }; }
    catch { return failed({ stage: "json", code: "output_json_invalid", networkAttempted: true, ...metadata, ...finish }, false, usage); }
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
