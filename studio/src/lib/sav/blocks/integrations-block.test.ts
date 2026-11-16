import { afterEach, describe, expect, it, vi } from "vitest";
import type { SavRetrievalBackend, SavRetrievalCandidate } from "../request-retrieval";
import { caseBlockCandidates } from "../cases/case-blocks";
import { SAV_CASE_BLOCK_REGISTRY } from "../cases/case-block-registry";
import { firstPersonalLoginRequest } from "../cases/investigation-return-qualify";
import { normalizeSensitiveText } from "../cases/sensitive-words";
import { savBlockManifestProblems, type SavBlockDraft } from "./block-attribution";
import { runSavBlockReplay } from "./block-replay";
import { SAV_INTEGRATIONS_BLOCK, SAV_INTEGRATIONS_PREPARATION } from "./integrations-block";
import { SAV_INTEGRATIONS_TEST_PHRASES } from "./integrations-phrases";
import { measureSavBlockRouting } from "./routing-measure";
import { createSavReplaySpendMeter, createSavReplayStubModel, runSavReplayDecision, savReplayBlockScope, type SavReplayCaseSource } from "./replay-decision";
import { runSavBlockReplayWithDecision } from "./replay-run";

const now = new Date("2026-11-16T09:00:00Z");
const indexed = SAV_INTEGRATIONS_TEST_PHRASES.filter(row => row.split === "index");
const holdout = SAV_INTEGRATIONS_TEST_PHRASES.filter(row => row.split === "holdout");
const norm = normalizeSensitiveText;
/** Test doubles only: these ids and procedures have NO relationship to K15-K24/K33/K34. */
function card(id: string, text: string): SavRetrievalCandidate {
  return { id, contentVersionId: `${id}-v1`, title: `SYN ${id}`, content: text, source: "studio", semanticScore: 0.9,
    verifiedAt: "2026-11-16T08:00:00Z", resolution: { symptoms: [], steps: ["Étape synthétique de recette, sans action externe."] },
    availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" } };
}
// Build the fake index from INDEX phrases only, never the holdout or its expected labels.
const toolCards = SAV_INTEGRATIONS_PREPARATION.subfamilies.map(tool => ({ tool: norm(tool),
  card: card(`syn-integrations-${norm(tool)}`, indexed.filter(row => norm(row.text).includes(norm(tool))).map(row => row.text).join("\n")) }));
const loginCard = card("syn-access", indexed.filter(row => row.expected === "access").map(row => row.text).join("\n"));
const boundDraft: SavBlockDraft = { ...SAV_INTEGRATIONS_BLOCK, cardIds: toolCards.map(row => row.card.id) };
const blocks: readonly SavBlockDraft[] = [boundDraft, { blockId: "access", family: "access", mode: "off", cardIds: [loginCard.id] }];
/** Deterministic tool-name search, NOT a semantic quality measurement. No embedding. */
const search: SavRetrievalBackend = {
  readRevision: async () => "syn-integrations-index",
  search: async queries => queries.map(query => {
    const text = norm(query), tool = toolCards.find(row => text.includes(row.tool));
    return tool ? [tool.card] : /code de connexion|lien de connexion/.test(text) ? [loginCard] : [];
  }),
};
const item = (row: typeof SAV_INTEGRATIONS_TEST_PHRASES[number]) => ({ kind: "phrase" as const, id: row.id, text: row.text });
afterEach(() => vi.unstubAllGlobals());

describe("SAV-92 integrations: offline and unbound by default", () => {
  it("cannot enter the live registry, acquire an entry rule or replay unpublished candidates", async () => {
    expect(SAV_INTEGRATIONS_BLOCK.mode).toBe("off");
    expect(SAV_INTEGRATIONS_BLOCK.cardIds).toEqual([]);
    expect(SAV_INTEGRATIONS_PREPARATION.candidateRefs).toEqual(["K15", "K16", "K17", "K18", "K19", "K20", "K21", "K22", "K23", "K24", "K33", "K34"]);
    expect(SAV_CASE_BLOCK_REGISTRY.map(row => [row.blockId, row.family])).toEqual([["access", "access"]]);
    expect(SAV_CASE_BLOCK_REGISTRY[0]!.firstRequest).toBe(firstPersonalLoginRequest);
    expect(caseBlockCandidates([{ blockId: "integrations", ruleId: "syn-integrations", revision: "syn", family: "usage", v1Kind: "support", at: now.toISOString() }], SAV_CASE_BLOCK_REGISTRY)).toEqual([]);
    expect(savBlockManifestProblems([SAV_INTEGRATIONS_BLOCK])).toEqual([{ code: "card_list_empty", blockId: "integrations" }]);
    const noSearch = vi.fn(async () => { throw Error("NO_SEARCH_BEFORE_BINDING"); });
    await expect(runSavBlockReplay([], { blocks: [SAV_INTEGRATIONS_BLOCK], now }, { search: { readRevision: async () => "syn", search: noSearch } }))
      .rejects.toThrow("card_list_empty:integrations");
    expect(noSearch).not.toHaveBeenCalled();
  });

  it("keeps exactly one third outside the fake index and reserves all providers in the indexed set", () => {
    expect([indexed.length, holdout.length]).toEqual([18, 9]);
    expect(new Set(SAV_INTEGRATIONS_TEST_PHRASES.map(row => row.text)).size).toBe(27);
    expect(toolCards.every(row => row.card.content.length > 0)).toBe(true);
    const indexContent = [...toolCards.map(row => row.card.content), loginCard.content].join("\n");
    for (const row of holdout) expect(indexContent).not.toContain(row.text);
    expect(savBlockManifestProblems(blocks)).toEqual([]);
  });
});

describe("synthetic attribution/replay contract (not real retrieval quality)", () => {
  it.each(SAV_INTEGRATIONS_TEST_PHRASES)("$id [$split]: $expected", async row => {
    const report = await runSavBlockReplay([item(row)], { blocks, now }, { search });
    const result = report.items[0]!;
    expect(result.status).toBe("ok");
    expect(result.attribution?.outcome === "block" ? result.attribution.blockId : result.attribution?.outcome).toBe(row.expected);
    expect(result.decision.status).toBe("not_requested");
    expect(report.totals).toMatchObject({ decisionCalls: 0, decisionCostUsd: 0, failures: 0 });
    expect(report.effects).toBe("none");
    if (row.expected === "access") expect(firstPersonalLoginRequest(row.text, "")).toBe(true);
  });

  it("reports index and holdout separately and leaves undersized sets below the existing release gate", async () => {
    const report = await runSavBlockReplay(SAV_INTEGRATIONS_TEST_PHRASES.map(item), { blocks, now }, { search });
    for (const [split, expected] of [["index", [13, 3, 2]], ["holdout", [5, 1, 3]]] as const) {
      const results = SAV_INTEGRATIONS_TEST_PHRASES.flatMap((phrase, index) => phrase.split === split
        ? [{ phrase, cards: report.items[index]!.topCards, attribution: report.items[index]!.attribution }] : []);
      const m = measureSavBlockRouting(boundDraft, results);
      expect([m.top3.hits, m.neighbourRejection.hits, m.traps.hits]).toEqual(expected);
      expect([m.top3.rate, m.neighbourRejection.rate, m.traps.rate]).toEqual([1, 1, 1]);
      expect(m.misses).toEqual([]);
      expect(m.gate.passed).toBe(false); // 18 / 9 individually: neither is a qualified release set.
      expect(m.gate.reasons).toEqual([`too_few_phrases:${results.length}<20`]);
    }
  });

  it("exercises the real runner/scope in memory using synthetic cards, with no network or external effect", async () => {
    const network = vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); }); vi.stubGlobal("fetch", network);
    const effects = { sendEmail: vi.fn(() => { throw Error("SEND_FORBIDDEN"); }), writeHubspot: vi.fn(() => { throw Error("CRM_FORBIDDEN"); }),
      reserveProductionSpend: vi.fn(() => { throw Error("SPEND_FORBIDDEN"); }) };
    const result = await runSavBlockReplayWithDecision({ blockId: "integrations", blocks, now,
      items: [item(SAV_INTEGRATIONS_TEST_PHRASES[0]!), item(SAV_INTEGRATIONS_TEST_PHRASES[13]!), item(SAV_INTEGRATIONS_TEST_PHRASES[16]!)], ports: { search, ...effects } });
    expect(result.transport).toBe("stub");
    expect(result.report.effects).toBe("none");
    expect(result.report.items.map(row => row.decision.status)).toEqual(["done", "other_block", "not_attributed"]);
    const decided = result.report.items[0]!.decision;
    expect(decided.status === "done" && decided.detail).toMatchObject({ outcome: "accepted", scope: "draft", transport: "stub", cost: { actualUsd: 0 },
      reply: { mode: "manual_reviewed" }, requests: [{ family: "usage" }] });
    expect(result.report.totals.decisionCostUsd).toBe(0);
    expect(result.spend.actualUsd).toBe(0);
    expect(network).not.toHaveBeenCalled();
    for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
    // An offline replay can simulate a decision even in mode off; this is NOT live activation.
    expect(boundDraft.mode).toBe("off");
  });
});

describe("scripted safety decisions through the existing runner (no real model)", () => {
  const source: SavReplayCaseSource = { kind: "synthetic", ref: "syn-capture", text: "La liaison Gmail échoue après reconnexion.", subject: "", family: "usage", blockId: "integrations" };
  const understanding = { requests: [{ id: "r1", summary: "Liaison Gmail bloquée", family: "usage", status: "open" }], newFacts: [] };
  const run = (output: unknown, attachments?: Extract<SavReplayCaseSource, { kind: "synthetic" }>["attachments"]) => runSavReplayDecision({ ...source, attachments }, {
    now, mailRef: source.ref, knowledge: [toolCards[0]!.card], blockMode: "off", scope: savReplayBlockScope(boundDraft, [toolCards[0]!.card]),
    meter: createSavReplaySpendMeter(), model: createSavReplayStubModel({ outputs: [output] }),
  });

  it("accepts one redacted screenshot request when absent, without claiming image reading", async () => {
    const question = "Pouvez-vous joindre une capture du message d'erreur en masquant les informations confidentielles ?";
    const result = await run({ caseVersion: 2, understanding, nextAction: { kind: "ask", questions: [{ text: question, requestId: "r1",
      reducesUncertainty: "Préciser le message d'erreur affiché.", seeks: [{ kind: "screenshot" }] }] },
      reply: { text: `Bonjour, ${question}`, citations: [], impossibilityClaims: [], accountAdvice: "none" } });
    expect(result).toMatchObject({ outcome: "accepted", action: "ask", modelCalls: 1, ask: { text: question }, attachments: [], reply: { mode: "manual_reviewed" } });
    expect(result.reply!.text).not.toMatch(/j'ai lu|j'ai analysé|résolu/i);
  });

  it("preserves an unread screenshot reference in a contextual human relay for a platform problem", async () => {
    const report = { need: "Gmail : lecture bloquée après reconnexion.", expected: "Lecture des messages.",
      observed: "Statut connecté déclaré par le client ; diagnostic du compte non vérifié ; erreur 403 signalée ; capture jointe non lue.",
      trialIds: [], hypotheses: ["Bug plateforme suspecté, non confirmé."], missingInformation: ["Diagnostic en lecture seule du compte connecté et sa source."],
      expectedIntervention: "Vérifier le diagnostic, l'erreur et la capture ; conserver la reconnexion déjà tentée, sans la redemander.", knowledge: [] };
    const result = await run({ caseVersion: 2, understanding, nextAction: { kind: "handoff", reason: "diagnosis_out_of_tools", requestIds: ["r1"], report } },
      [{ filename: "syn-erreur.png", mimeType: "image/png", size: 1234 }]);
    expect(result).toMatchObject({ outcome: "accepted", action: "handoff", reply: null, team: { reason: "diagnosis_out_of_tools" },
      attachments: [{ name: "syn-erreur.png", notAttached: "media_off", v1Reading: false }] });
  });
});
