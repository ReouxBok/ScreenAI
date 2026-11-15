import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SavRetrievalBackend, SavRetrievalCandidate } from "../request-retrieval";
import { SAV_CASE_ACCESS_URL, SAV_CASE_TEAM_PART_MENTION } from "../cases/decision-contract";
import { SAV_REPLY_NOTICE } from "../reply-format";
import type { SavBlockDraft } from "./block-attribution";
import type { SavReplayItem } from "./block-replay";
import {
  createSavReplaySpendMeter, createSavReplayStubModel, runSavReplayDecision, savReplayInvestigationPorts, synthesizeSavReplayCase, SAV_REPLAY_STUB_MODEL,
  type SavReplayModelTransport,
} from "./replay-decision";
import { createSavReplayLiveModel } from "./replay-decision-live";
import { runSavBlockReplayWithDecision } from "./replay-run";

// Synthetic cards and phrases only (SYN): no database, no network, no model, no customer content.
const now = new Date("2026-11-15T10:00:00Z");
const candidate = (id: string, title: string, semanticScore: number, steps: string[]): SavRetrievalCandidate => ({
  id, contentVersionId: `${id}-v1`, title, content: `${title}. Procédure.`, source: "studio", verifiedAt: "2026-11-01T00:00:00Z", semanticScore,
  resolution: { steps, symptoms: [] },
  availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" },
});
const CARDS = {
  login: candidate("card-login", "Se reconnecter à son compte", 0.86, ["Ouvrez la page de connexion.", "Saisissez votre adresse e-mail puis validez."]),
  phone: candidate("card-phone", "Agent téléphonique muet", 0.84, ["Vérifiez que l'agent est publié."]),
};
const blocks: SavBlockDraft[] = [
  { blockId: "access", mode: "automatic", cardIds: ["card-login"] },
  { blockId: "telephony", mode: "shadow", cardIds: ["card-phone"] },
];
function fakeSearch(): SavRetrievalBackend {
  return {
    readRevision: async () => "kb-syn",
    async search(queries) {
      return queries.map(query => /t[ée]l[ée]phon/i.test(query) ? [CARDS.phone] : /connect/i.test(query) ? [CARDS.login] : [{ ...CARDS.login, semanticScore: 0.2 }]);
    },
  };
}
/** Effect members a careless wiring could reach for: each throws, none may be called. */
function trapEffects() {
  return { sendEmail: vi.fn(() => { throw new Error("EFFECT_SEND"); }), writeHubspot: vi.fn(() => { throw new Error("EFFECT_HUBSPOT"); }),
    postSlack: vi.fn(() => { throw new Error("EFFECT_SLACK"); }), mutateCase: vi.fn(() => { throw new Error("EFFECT_CASE"); }),
    writeEffectRegistry: vi.fn(() => { throw new Error("EFFECT_REGISTRY"); }), reserveProductionSpend: vi.fn(() => { throw new Error("EFFECT_SPEND"); }) };
}
const login = "Bonjour, je n'arrive pas à me connecter à mon compte depuis ce matin.";
const run = (items: SavReplayItem[], extra: Partial<Parameters<typeof runSavBlockReplayWithDecision>[0]> = {}) =>
  runSavBlockReplayWithDecision({ blockId: "access", blocks, items, now, ports: { search: fakeSearch() }, ...extra });
/** A model transport shaped like the live one (reservation, cost), with no network: every call costs `cost` and is counted. */
function pricedModel(reserve: number, cost: number) {
  const stub = createSavReplayStubModel(), calls: string[] = [];
  const model: SavReplayModelTransport = { kind: "live", model: "syn-priced", reservePerCallUsd: reserve, estimateUsd: () => cost,
    async call(request) { calls.push(request.callKey); const answer = await stub.call(request); return { ...answer, costUsd: cost }; } };
  return { model, calls };
}

afterEach(() => vi.unstubAllGlobals());

describe("phase 1b replay: the real decision path, report shape", () => {
  it("returns block, reply the customer would receive, per-request actions, attachments and cost for a replayed phrase", async () => {
    const { report, summary, spend, transport, model } = await run([
      { kind: "phrase", id: "p1", subject: "Connexion", text: login, attachments: [{ filename: "erreur.png", mimeType: "image/png", size: 245_000, reading: "Erreur E42" }] },
      { kind: "phrase", id: "p2", text: "Mon agent téléphonique ne répond plus au téléphone" },
      { kind: "phrase", id: "p3", text: "Je veux être remboursé de ma facture" },
    ]);
    expect([transport, model]).toEqual(["stub", SAV_REPLAY_STUB_MODEL]);
    expect(report.effects).toBe("none");
    expect(report.items.map(item => [item.ref, item.attribution?.outcome, item.decision.status])).toEqual([
      ["phrase:p1", "block", "done"], ["phrase:p2", "block", "other_block"], ["phrase:p3", "team", "not_attributed"]]);
    const decision = report.items[0]!.decision;
    if (decision.status !== "done") throw new Error("not decided");
    const detail = decision.detail!;
    expect(detail).toMatchObject({ runner: "recorded", outcome: "accepted", action: "answer", team: null, ask: null, replyLimit: null, refusals: [], rejections: [],
      modelCalls: 1, transport: "stub", budget: "ok", cost: { calls: 1, estimatedUsd: 0, reservedUsd: 0, actualUsd: 0 },
      requests: [{ id: "r1", family: "access", status: "open", action: "answer" }],
      attachments: [{ id: "pj1", name: "erreur.png", type: "image/png", kind: "image", notAttached: "media_off", v1Reading: true }] });
    // The exact text: the draft, the access link the validator requires, the help line, the signature and the automatic AI notice (block in automatic mode).
    expect(detail.reply).toMatchObject({ purpose: "answer", mode: "automated" });
    expect(detail.reply!.text).toContain("1. Ouvrez la page de connexion.");
    expect(detail.reply!.text).toContain(SAV_CASE_ACCESS_URL);
    expect(detail.reply!.text).toContain(SAV_REPLY_NOTICE);
    expect(decision.reply).toBe(detail.reply!.text);
    expect(report.totals).toMatchObject({ items: 3, decisionCalls: 1, decisionCostUsd: 0, budgetStopped: false });
    expect(spend).toMatchObject({ runCapUsd: 2, mailCapUsd: 0.5, calls: 1, refused: 0, actualUsd: 0 });
    expect(summary).toContain("# Rejeu du bloc « access »");
    expect(summary).toContain("bouchon déterministe");
    expect(summary).toContain("Décisions calculées : 1 ; réponses : 1");
    expect(summary).toContain(`> 1. Ouvrez la page de connexion.`);
  });

  it("a block in shadow mode replays a reply for a person to validate (no automatic notice); without a card, ONE question is the reply", async () => {
    const shadow = blocks.map(block => ({ ...block, mode: "shadow" as const }));
    const { report } = await runSavBlockReplayWithDecision({ blockId: "access", blocks: shadow, now, items: [{ kind: "phrase", text: login }], ports: { search: fakeSearch() } });
    const first = report.items[0]!.decision;
    expect(first.status === "done" && first.detail!.reply).toMatchObject({ mode: "manual_reviewed" });
    expect(first.status === "done" && first.detail!.reply!.text).not.toContain(SAV_REPLY_NOTICE);
    const asked = await runSavReplayDecision({ kind: "synthetic", ref: "q", subject: "", text: login, family: "access", blockId: "access" },
      { model: createSavReplayStubModel(), meter: createSavReplaySpendMeter(), now, mailRef: "q", knowledge: [], blockMode: "automatic" });
    expect(asked).toMatchObject({ outcome: "accepted", action: "ask", ask: { requestId: "r1" }, reply: { purpose: "question", mode: "automated" }, requests: [{ id: "r1", action: "ask" }] });
    expect(asked.reply!.text).toContain("ce qui s'affiche à l'écran");
  });
});

describe("phase 1b replay: zero effect", () => {
  it("never reaches an effect, the network or a production register; the runner's ports are memory and one injected model call", async () => {
    const network = vi.fn(async () => { throw new Error("NETWORK_FORBIDDEN"); });
    vi.stubGlobal("fetch", network);
    const effects = trapEffects();
    const { report } = await runSavBlockReplayWithDecision({ blockId: "access", blocks, now, items: [{ kind: "phrase", text: login }],
      ports: { search: fakeSearch(), ...effects } as never });
    expect(report.items[0]!.decision).toMatchObject({ status: "done", action: "answer" });
    for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();

    // The ports handed to the production runner: exactly these, none of them an effect; the only write ports keep to this run's memory.
    const replay = synthesizeSavReplayCase({ kind: "synthetic", ref: "p1", subject: "", text: login, family: "access", blockId: "access" }, now);
    const wired = savReplayInvestigationPorts(replay, { model: createSavReplayStubModel(), meter: createSavReplaySpendMeter(), now, mailRef: "p1", knowledge: [CARDS.login], blockMode: "automatic" });
    expect(Object.keys(wired.ports).sort()).toEqual(["admissionPolicyRevision", "callModel", "claim", "customerContext", "customerTexts", "knowledge", "now", "pauseState",
      "progress", "readCase", "readTicketOwner", "record", "reevaluateAdmission", "release", "revisions", "scope"]);
    await expect(wired.ports.reevaluateAdmission(replay.snapshot)).rejects.toThrow("SAV_REPLAY_NO_WRITE");
    await wired.ports.record({} as never);
    expect(wired.records).toHaveLength(1);
  });

  it("imports no module able to send, write HubSpot or Slack, mutate a case or write a production ledger (static proof)", () => {
    const forbidden = /gmail|hubspot|slack|case-effect|executor|case-store|customer-return|reply-passage|reply-store|ledger|spend|lease|outbox|@\/db/i;
    for (const file of ["replay-decision.ts", "replay-run.ts", "replay-summary.ts"]) {
      const source = readFileSync(path.join(__dirname, file), "utf8");
      const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(match => match[1]!);
      expect(imports.filter(target => forbidden.test(target)), file).toEqual([]);
    }
    // The live transport reads the spend POLICY (prices, bounds) and calls the production provider; it never builds the production
    // spend register, the call ledger or a database handle.
    const live = readFileSync(path.join(__dirname, "replay-decision-live.ts"), "utf8");
    expect(live).not.toMatch(/caseV2ModelSpend|caseV2EmbeddingSpend|caseCallLedger|requireDb|reserveCaseV2|settleCaseV2|insert\(|update\(|transaction\(/);
    expect([...live.matchAll(/import\s+\{([^}]+)\}\s+from\s+["']\.\.\/cases\/investigation-v2-spend["']/g)].flatMap(match => match[1]!.split(",").map(name => name.trim())).sort())
      .toEqual(["readCaseV2SpendPolicy", "readCaseV2TransportPolicy"]);
    // The read ports reach the case store for its two reads only.
    const ports = readFileSync(path.join(__dirname, "block-replay-ports.ts"), "utf8");
    expect(ports).toMatch(/import \{ listCaseEvents, readCase \} from "\.\.\/cases\/case-store";/);
  });
});

describe("phase 1b replay: budget", () => {
  it("validates the caps: 2 USD by default, 10 USD at most, a mail cap within the run cap", () => {
    expect(createSavReplaySpendMeter().totals()).toMatchObject({ runCapUsd: 2, mailCapUsd: 0.5 });
    expect(() => createSavReplaySpendMeter({ runCapUsd: 10.01 })).toThrow("SAV_REPLAY_BUDGET_INVALID");
    expect(() => createSavReplaySpendMeter({ runCapUsd: 0 })).toThrow("SAV_REPLAY_BUDGET_INVALID");
    expect(() => createSavReplaySpendMeter({ runCapUsd: 1, mailCapUsd: 2 })).toThrow("SAV_REPLAY_MAIL_BUDGET_INVALID");
    const meter = createSavReplaySpendMeter({ runCapUsd: 1, mailCapUsd: 0.5 });
    const first = meter.reserve("m1", 0.4);
    expect(first.ok).toBe(true);
    expect(meter.reserve("m1", 0.4)).toEqual({ ok: false, reason: "mail_cap" });
    meter.settle((first as { id: number }).id, 0.1);
    // Settled below the reservation: the room comes back; an uncertain one keeps its reservation.
    const second = meter.reserve("m1", 0.4) as { id: number };
    meter.settle(second.id, null);
    expect(meter.totals()).toMatchObject({ calls: 2, refused: 1, actualUsd: 0.5, committedUsd: 0.5 });
  });

  it("stops the run when the run cap is reached: no further call is sent, the rest is reported skipped_budget", async () => {
    const { model, calls } = pricedModel(0.8, 0.7);
    const items = Array.from({ length: 4 }, (_, index) => ({ kind: "phrase" as const, id: `p${index + 1}`, text: login }));
    const { report, spend, summary } = await run(items, { model, budget: { runUsd: 2, mailUsd: 1 } });
    // 0.7 + 0.7 settled = 1.4; a third reservation of 0.8 would pass 2: refused, never sent; the fourth is not even tried.
    expect(calls).toHaveLength(2);
    expect(report.items.map(item => item.decision.status)).toEqual(["done", "done", "skipped_budget", "skipped_budget"]);
    expect(report.totals).toMatchObject({ decisionCalls: 2, decisionSkippedBudget: 2, budgetStopped: true });
    expect(report.totals.decisionCostUsd).toBeCloseTo(1.4);
    expect(report.totals.decisionEstimatedUsd).toBeCloseTo(1.4);
    expect(spend).toMatchObject({ calls: 2, refused: 1 });
    expect(spend.actualUsd).toBeCloseTo(1.4);
    expect(summary).toContain("Plafond atteint");
  });

  it("the per-mail cap stops the corrections of one mail, never the next mail", async () => {
    const asking = { caseVersion: 2, understanding: { requests: [{ id: "r1", summary: "Connexion", family: "access", status: "open" }], newFacts: [] },
      nextAction: { kind: "ask", questions: [{ text: "Quel code avez-vous reçu ?", requestId: "r1", reducesUncertainty: "x", seeks: [{ kind: "credential" }] }] },
      reply: { text: `Bonjour, quel code avez-vous reçu ? ${SAV_CASE_ACCESS_URL}`, citations: [], impossibilityClaims: [], accountAdvice: "none" } };
    const scripted = createSavReplayStubModel({ outputs: [asking, asking] });
    const model: SavReplayModelTransport = { ...scripted, kind: "live", reservePerCallUsd: 0.3, estimateUsd: () => 0.1, call: async request => ({ ...(await scripted.call(request)), costUsd: 0.25 }) };
    const { report } = await run([{ kind: "phrase", id: "a", text: login }], { model, budget: { runUsd: 2, mailUsd: 0.5 } });
    const decision = report.items[0]!.decision;
    // One call (0.25), then a correction reservation of 0.3 would pass the 0.5 mail cap: deferred, nothing sent.
    expect(decision).toMatchObject({ status: "done", detail: { runner: "deferred_budget", budget: "mail_cap", modelCalls: 1, cost: { calls: 1 }, reply: null } });
    expect(report.totals.budgetStopped).toBe(false);
  });
});

describe("phase 1b replay: multi-request, refusals, determinism", () => {
  it("a multi-request mail gets ONE combined reply: every covered request answered, the team's part named by the server's fixed sentence", async () => {
    const { report } = await run([{ kind: "phrase", id: "multi", text: `${login} Et comment exporter mes données ?`, requests: [
      { text: "Je n'arrive pas à me connecter à mon compte" }, { text: "Le lien de connexion reçu ne s'ouvre pas" }, { text: "Comment exporter mes données ?", family: "other", team: true }] }]);
    const decision = report.items[0]!.decision;
    if (decision.status !== "done") throw new Error("not decided");
    const detail = decision.detail!;
    expect(detail).toMatchObject({ outcome: "accepted", action: "answer", modelCalls: 1 });
    expect(detail.requests.map(row => [row.id, row.status, row.action])).toEqual([["r1", "open", "answer"], ["r2", "open", "answer"], ["r3", "handed_off", "team_part"]]);
    expect(detail.reply!.draft.trimEnd().endsWith(SAV_CASE_TEAM_PART_MENTION)).toBe(true);
    expect(detail.reply!.text.split(SAV_CASE_TEAM_PART_MENTION)).toHaveLength(2);
  });

  it("surfaces the validator's refusals with their reasons; refused twice, the mail goes to the team", async () => {
    const password = { caseVersion: 2, understanding: { requests: [{ id: "r1", summary: "Connexion", family: "access", status: "open" }], newFacts: [] },
      nextAction: { kind: "ask", questions: [{ text: "Pouvez-vous nous envoyer votre mot de passe ?", requestId: "r1", reducesUncertainty: "x", seeks: [{ kind: "credential" }] }] },
      reply: { text: "Bonjour, envoyez-nous votre mot de passe.", citations: [], impossibilityClaims: [], accountAdvice: "none" } };
    const { report, summary } = await run([{ kind: "phrase", text: login }], { model: createSavReplayStubModel({ outputs: [password, password, password] }) });
    const decision = report.items[0]!.decision;
    if (decision.status !== "done") throw new Error("not decided");
    const detail = decision.detail!;
    expect(detail).toMatchObject({ runner: "recorded", outcome: "needs_review", action: "team", reply: null, replyLimit: "decision_refused",
      team: { reason: "decision_refused" }, requests: [{ id: "r1", action: "team" }] });
    expect(detail.refusals.length).toBeGreaterThanOrEqual(2);
    expect(detail.refusals[0]!.codes).toEqual(expect.arrayContaining(["credential_requested", "access_link_missing"]));
    expect(detail.rejections).toEqual(expect.arrayContaining([expect.objectContaining({ code: "credential_requested", path: expect.any(String), label: expect.stringContaining("mot de passe") })]));
    expect(decision.refusals).toEqual(expect.arrayContaining(["credential_requested"]));
    expect(summary).toMatch(/Refus du validateur : .*credential_requested \(1\)/);
  });

  it("the stub is deterministic: the same replay gives the same report", async () => {
    const items: SavReplayItem[] = [{ kind: "phrase", id: "p1", text: login }, { kind: "phrase", id: "p2", text: "Mon agent téléphonique est muet au téléphone" }];
    const first = await run(items), second = await run(items);
    expect(second.report).toEqual(first.report);
    expect(second.summary).toBe(first.summary);
  });

  it("refuses an unknown block before replaying anything", async () => {
    await expect(runSavBlockReplayWithDecision({ blockId: "nope", blocks, now, items: [], ports: { search: fakeSearch() } })).rejects.toThrow("SAV_REPLAY_BLOCK_UNKNOWN");
  });
});

describe("phase 1b replay: the live transport (fake network only)", () => {
  const STAFF = "00000000-0000-4000-8000-000000000001";
  const SPEND = { revision: "spend-syn-r1", approvedBy: STAFF, approvedAt: "2026-11-01T00:00:00Z",
    transport: { model: "syn-model", embeddingModel: "syn-embedding", priceExpiresAt: "2027-01-01T00:00:00Z", maxInputTokens: 131072, maxOutputTokens: 1024, maxInputBytes: 100_000, embeddingMaxInputTokens: 8192, embeddingMaxTexts: 3, embeddingMaxTextBytes: 4000 },
    embedding: { dailyCapMicroUsd: 10_000, reserveMicroUsdPerCall: 100, microUsdPerMillionInputTokens: 150 },
    model: { dailyCapMicroUsd: 1_000_000, reserveMicroUsdPerCall: 50_000, microUsdPerMillionInputTokens: 300, microUsdPerMillionOutputTokens: 2_500 } };
  const env = { SAV_V2_GEMINI_API_KEY: "syn-v2-key", SAV_V2_MODEL: "syn-model", SAV_V2_EMBEDDING_MODEL: "syn-embedding", SAV_V2_SPEND_POLICY_JSON: JSON.stringify(SPEND) };

  it("sends the production prompt once per call through the given network, and costs it from the reported usage, in memory only", async () => {
    const bodies: string[] = [];
    const network = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      const request = JSON.parse(String(init.body)) as { contents: Array<{ parts: Array<{ text?: string }> }> };
      const payload = request.contents[0]!.parts.map(part => part.text ?? "").join("");
      const caseVersion = /"caseVersion":\s*(\d+)/.exec(payload)?.[1];
      const output = { caseVersion: Number(caseVersion), understanding: { requests: [{ id: "r1", summary: "Connexion", family: "access", status: "open" }], newFacts: [] },
        nextAction: { kind: "answer", requestIds: ["r1"], steps: [{ text: "Ouvrez la page de connexion.", knowledge: { knowledgeId: "card-login", contentVersionId: "card-login-v1" }, newFactIds: [] }], expectedResult: "Connexion rétablie." },
        reply: { text: `Bonjour, ouvrez la page de connexion : ${SAV_CASE_ACCESS_URL}`, citations: [{ knowledgeId: "card-login", contentVersionId: "card-login-v1" }], impossibilityClaims: [], accountAdvice: "none" } };
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10_000, candidatesTokenCount: 400, thoughtsTokenCount: 100 } }), { status: 200 });
    });
    const model = createSavReplayLiveModel({ env, network });
    // Worst case reserved per call: the full input window and the maximum output at the policy's prices.
    expect(model.reservePerCallUsd).toBeCloseTo((131072 * 300 + 1024 * 2500) / 1e12);
    const { report, spend } = await run([{ kind: "phrase", text: login }], { model });
    expect(network).toHaveBeenCalledTimes(1);
    expect(network.mock.calls[0]![0]).toContain("/models/syn-model:generateContent");
    expect(bodies[0]).toContain("Tu es l'agent SAV V2 de Limova");
    const decision = report.items[0]!.decision;
    expect(decision).toMatchObject({ status: "done", action: "answer", detail: { transport: "live", model: "syn-model", outcome: "accepted", cost: { calls: 1 } } });
    const actual = (10_000 * 300 + 500 * 2500) / 1e12;
    expect(spend.actualUsd).toBeCloseTo(Math.ceil(actual * 1e6) / 1e6);
    expect(decision.status === "done" && decision.detail!.cost.estimatedUsd).toBeGreaterThan(0);
  });

  it("is not built without an approved spend policy (no guessed price)", () => {
    expect(() => createSavReplayLiveModel({ env: { ...env, SAV_V2_SPEND_POLICY_JSON: undefined } })).toThrow("SAV_REPLAY_LIVE_V2_SPEND_POLICY_ABSENT");
    expect(() => createSavReplayLiveModel({ env: { ...env, SAV_V2_MODEL: "other-model" } })).toThrow("SAV_V2_TRANSPORT_POLICY_INVALID");
  });
});
