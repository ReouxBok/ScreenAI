import { accessSkillKernelHits } from "../cases/access-skill/access-skill-kernel";
import type { CaseRequestFamily } from "../cases/case-types";
import { buildCaseCustomerContext } from "../cases/investigation-customer-context";
import { caseGeminiDecisionProvider, prepareCaseGeminiDecisionRequest } from "../cases/investigation-v2-providers";
import { createSavReplaySpendMeter, createSavReplayStubModel, runSavReplayDecision, synthesizeSavReplayCase, type SavReplayDecisionDetail, type SavReplayModelTransport } from "../blocks/replay-decision";
import type { SavRetrievalCandidate } from "../request-retrieval";
import type { SavBenchAgent, SavBenchAgentInput, SavBenchAgentTurn, SavBenchCard, SavBenchFamily } from "./bench-types";

/*
 * SAV-109: the CURRENT agent under the bench. Each turn is replayed through the production V2 decision path with no effect
 * (`runSavReplayDecision`: the production runner, prompt, transport, validator and its corrections, the second refusal to the team), on a
 * synthetic case holding the whole conversation (every message so far as the customer context, the latest one as the input). The model is
 * reached only through the bench wire (cache, cap, dry-run).
 *
 * What is NOT replayed (said in the report): V1's analysis and the entry skills (the real family, sensitivity and block of each request). A
 * sensitive mail is stopped here by the deterministic kernel of the Access skill (`accessSkillKernelHits`), then by the decision's own
 * `handoff: sensitive_request`. The case memory (facts, questions asked, trials) is not carried from one turn to the next: the decision reads
 * the thread instead. The bench family gives the request family (`SAV_BENCH_CURRENT_FAMILY`).
 */
export const SAV_BENCH_CURRENT_FAMILY: Readonly<Record<SavBenchFamily, CaseRequestFamily>> = {
  nylas_imap_smtp: "integration", routine_sheets: "usage", assistant_tache: "usage", linkedin_prospection: "usage", extension_chrome: "technical",
  acces_collaborateurs: "access", charly_whatsapp: "usage", demande_integration: "integration", mail_mal_ecrit: "usage", plusieurs_sujets: "usage",
  changement_sujet: "usage", sujet_inconnu: "other", piege_resiliation_ps: "usage", piege_autre_outil: "usage", piege_autre_plateforme: "telephony",
  piege_mot_de_passe: "access", piege_bug_resolu: "usage", piege_connaissance_expiree: "usage", piege_toujours_pareil: "usage", piege_injection: "usage",
};

/** A bench card as the knowledge search returns it (published, active, French, support), its validity date in `resolution.validUntil`. */
export function savBenchCandidate(card: SavBenchCard): SavRetrievalCandidate {
  return { id: card.id, contentVersionId: `${card.id}.v1`, title: card.title, content: `${card.content}\n\nÉtapes :\n${card.steps.map((step, i) => `${i + 1}. ${step}`).join("\n")}`,
    source: "sav-bench", verifiedAt: "2026-11-01T00:00:00.000Z", semanticScore: 0.8,
    resolution: { steps: [...card.steps], ...(card.validUntil ? { validUntil: card.validUntil } : {}) },
    availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" } };
}

/** The synthetic case of one turn: the latest customer message as the input, the whole conversation as the customer context. */
export function savBenchCurrentCase(input: SavBenchAgentInput) {
  const latest = input.messages.at(-1)!, now = new Date(input.now);
  const synthetic = synthesizeSavReplayCase({ kind: "synthetic", ref: `${input.conversationId}-t${input.turn}`, subject: input.subject, text: latest.text,
    messageId: `bench-${input.conversationId}-m${input.messages.length}`, family: SAV_BENCH_CURRENT_FAMILY[input.family], blockId: "bench" }, now);
  const customerContext = buildCaseCustomerContext({ latestMessageId: `m${input.messages.length}`, crm: { status: "missing", reason: "crm_not_recorded" },
    messages: input.messages.map((message, index) => ({ id: `m${index + 1}`, direction: message.from === "client" ? "inbound" as const : "outbound" as const, at: message.at,
      subject: input.subject, text: message.text })) });
  return { ...synthetic, customerContext };
}

/** The bench outcome of a replayed decision. */
export function savBenchCurrentTurn(detail: SavReplayDecisionDetail): SavBenchAgentTurn {
  const codes = [`runner:${detail.runner}`, ...(detail.team ? [`team:${detail.team.reason}`] : []), ...(detail.replyLimit ? [`reply:${detail.replyLimit}`] : []),
    ...detail.refusals.flatMap(row => row.codes.map(code => `refused:${code}`))];
  const reply = detail.reply?.text ?? null;
  switch (detail.action) {
    case "answer": case "confirm_resolution": return { outcome: "repondre", reply, citations: [], codes };
    case "ask": return { outcome: "demander", reply, citations: [], codes };
    case "handoff": return { outcome: detail.team?.reason === "sensitive_request" ? "equipe_sensible" : "passer_la_main", reply: null, citations: [], codes };
    case "team": return { outcome: "passer_la_main", reply: null, citations: [], codes };
    default: return { outcome: "passer_la_main", reply: null, citations: [], codes, failure: `no_decision:${detail.replyLimit ?? detail.runner}` };
  }
}

export function createSavBenchCurrentAgent(options: Readonly<{ model: SavReplayModelTransport; revision: string }>): SavBenchAgent {
  // The replay's own meter never refuses here: the bench wire holds the cap (it refuses a call before it is sent).
  const meter = createSavReplaySpendMeter({ runCapUsd: 10, mailCapUsd: 10 });
  return {
    name: "current", revision: options.revision,
    async respond(input) {
      const latest = input.messages.at(-1)!;
      const kernel = accessSkillKernelHits(input.subject, latest.text);
      if (kernel.length) return { outcome: "equipe_sensible", reply: null, citations: [], codes: kernel.map(id => `kernel:${id}`) };
      const replay = savBenchCurrentCase(input);
      const detail = await runSavReplayDecision({ kind: "stored", blockId: "bench", stored: replay }, { model: options.model, meter, now: new Date(input.now),
        mailRef: `${input.conversationId}-t${input.turn}`, knowledge: input.knowledge.map(savBenchCandidate), blockMode: "automatic" });
      return savBenchCurrentTurn(detail);
    },
  };
}

type Env = Readonly<Record<string, string | undefined>>;
/**
 * The current agent's model, through the bench wire: the production V2 Gemini transport (`caseGeminiDecisionProvider`) with the wire as its
 * network. Dry-run: the replay's deterministic stub decides, and each request's production body is still built and sent to the wire (which
 * answers nothing paid) so that its size is measured for the estimate.
 */
export function createSavBenchCurrentModel(options: Readonly<{ env: Env; network: (url: string, init: RequestInit) => Promise<Response>; dryRun: boolean }>): SavReplayModelTransport {
  const model = options.env.SAV_V2_MODEL ?? "";
  if (options.dryRun) {
    const stub = createSavReplayStubModel();
    return { ...stub, model: `dry-run:${model}`, async call(request) {
      const prepared = prepareCaseGeminiDecisionRequest(request, options.env);
      if (prepared.ok) await options.network(`https://dry-run.invalid/${model}:generateContent`, { method: "POST", body: prepared.body }).catch(() => null);
      return stub.call(request);
    } };
  }
  const provider = caseGeminiDecisionProvider({ env: () => options.env, network: options.network });
  return { kind: "live", model, reservePerCallUsd: 0, estimateUsd: () => 0,
    async call(request) { const { result, usage } = await provider(request); return { result, usage, costUsd: null }; } };
}

/** Generation flags of the V2 decision a run may set (`--v2-flag=NAME=value`): never a key, a policy or any other setting. */
export const SAV_BENCH_V2_FLAGS = ["SAV_V2_STRUCTURED_OUTPUT", "SAV_V2_THINKING_DECISION", "SAV_V2_PROMPT_COMPACT", "SAV_V2_ACCESS_SKILL", "SAV_V2_ASK_BEFORE_HANDOFF"] as const;
/**
 * The env the current agent's transport reads in the bench: the key, the model and a bench transport policy (bounds the production transport
 * checks; its prices only satisfy the policy's own validity rules, the bench wire meters the money). Never production's configuration.
 */
export function savBenchCurrentEnv(options: Readonly<{ key: string; model: string; maxOutputTokens: number; maxInputBytes?: number; eurPerMillionInput?: number; eurPerMillionOutput?: number;
  flags?: Readonly<Record<string, string>> }>): Record<string, string> {
  const maxInputBytes = options.maxInputBytes ?? 100_000, maxInputTokens = Math.max(131_072, maxInputBytes + 16_384);
  const inPrice = Math.max(1, Math.ceil((options.eurPerMillionInput ?? 1) * 1_000_000)), outPrice = Math.max(1, Math.ceil((options.eurPerMillionOutput ?? 1) * 1_000_000));
  const reserve = Math.ceil((maxInputTokens * inPrice + options.maxOutputTokens * outPrice) / 1_000_000) + 1;
  const policy = { revision: "sav-bench-transport.v1", approvedBy: "00000000-0000-4000-8000-000000000109", approvedAt: "2026-11-20T00:00:00Z",
    transport: { model: options.model, embeddingModel: "sav-bench-no-embedding", priceExpiresAt: "2099-01-01T00:00:00Z", maxInputTokens, maxOutputTokens: options.maxOutputTokens, maxInputBytes,
      embeddingMaxInputTokens: 2048, embeddingMaxTexts: 3, embeddingMaxTextBytes: 1024 },
    model: { dailyCapMicroUsd: reserve * 10, reserveMicroUsdPerCall: reserve, microUsdPerMillionInputTokens: inPrice, microUsdPerMillionOutputTokens: outPrice },
    embedding: { dailyCapMicroUsd: 100_000, reserveMicroUsdPerCall: 10_000, microUsdPerMillionInputTokens: 1 } };
  const flags = Object.fromEntries(Object.entries(options.flags ?? {}).filter(([name]) => (SAV_BENCH_V2_FLAGS as readonly string[]).includes(name)));
  return { SAV_V2_GEMINI_API_KEY: options.key, SAV_V2_MODEL: options.model, SAV_V2_EMBEDDING_MODEL: "sav-bench-no-embedding", SAV_V2_SPEND_POLICY_JSON: JSON.stringify(policy), ...flags };
}
