import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SavRetrievalBackend, SavRetrievalCandidate } from "../request-retrieval";
import { attributeSavBlockByCards, savBlockManifestProblems, type SavBlockDraft, type SavRankedCard } from "./block-attribution";
import { measureSavBlockTestPhrases, runSavBlockReplay, SAV_REPLAY_LIMITS, type SavReplayPorts } from "./block-replay";
import { measureSavBlockRouting, type SavRoutingPhraseResult } from "./routing-measure";

const now = new Date("2026-11-15T10:00:00Z");
const candidate = (id: string, title: string, semanticScore: number, symptoms: string[] = []): SavRetrievalCandidate => ({
  id, contentVersionId: `${id}-v1`, title, content: `${title}. Procédure.`, source: "studio", verifiedAt: "2026-11-01T00:00:00Z", semanticScore,
  resolution: { steps: ["Étape unique."], symptoms },
  availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" },
});
const CARDS = {
  login: candidate("card-login", "Se reconnecter à son compte", 0.86, ["je n'arrive pas à me connecter"]),
  code: candidate("card-code", "Code de connexion non reçu", 0.8, ["pas reçu le code"]),
  agent: candidate("card-agent", "Configurer un agent téléphonique", 0.62, ["agent téléphonique"]),
  phone: candidate("card-phone", "Agent téléphonique muet", 0.84, ["l'agent ne répond pas au téléphone"]),
  spare: candidate("card-spare", "Notes internes", 0.7),
};
const blocks: SavBlockDraft[] = [
  { blockId: "access", mode: "automatic", cardIds: ["card-login", "card-code"], exclusions: ["inviter un collaborateur"] },
  { blockId: "telephony", mode: "shadow", cardIds: ["card-agent", "card-phone"] },
];
/** A fake index: the cards each query returns, chosen by keywords (no network, no embedding). */
function fakeSearch(overrides: Partial<Record<string, SavRetrievalCandidate[]>> = {}) {
  const calls: string[] = [];
  const backend: SavRetrievalBackend = {
    readRevision: async () => "kb-test",
    async search(queries) {
      calls.push(...queries);
      return queries.map(query => {
        for (const [key, value] of Object.entries(overrides)) if (query.includes(key)) { if (!value) throw new Error("down"); return value; }
        if (/t[ée]l[ée]phon/i.test(query)) return [CARDS.phone, CARDS.agent, CARDS.spare];
        if (/connect|code/i.test(query)) return [CARDS.login, CARDS.code, CARDS.spare];
        return [{ ...CARDS.spare, semanticScore: 0.4 }];
      });
    },
  };
  return { backend, calls };
}
/** Effect members a careless runner could reach for: every one throws, and none may be called. */
function trapEffects() {
  const effects = { sendEmail: vi.fn(() => { throw new Error("EFFECT_SEND"); }), writeHubspot: vi.fn(() => { throw new Error("EFFECT_HUBSPOT"); }),
    mutateCase: vi.fn(() => { throw new Error("EFFECT_CASE"); }), reserveBudget: vi.fn(() => { throw new Error("EFFECT_BUDGET"); }) };
  return effects;
}

describe("replay: report and zero effect", () => {
  it("replays stored mails and phrases into a report (block / question / team), with top cards and scores, and calls no effect", async () => {
    const effects = trapEffects();
    const { backend, calls } = fakeSearch();
    const readMail = vi.fn(async (id: string) => id === "msg-access-1"
      ? { subject: "Connexion impossible", text: "Bonjour,\nJe n'arrive pas à me connecter, pas reçu le code.\n\nLe ven. a écrit :\n> ancien message facture" }
      : id === "msg-refund-1" ? { subject: "Remboursement", text: "Je veux être remboursé de ma facture." } : null);
    const ports = { readMail, search: backend, ...effects } as SavReplayPorts & typeof effects;
    const report = await runSavBlockReplay([
      { kind: "mail", messageId: "msg-access-1" }, { kind: "mail", messageId: "msg-refund-1" }, { kind: "mail", messageId: "msg-missing" },
      { kind: "phrase", text: "Mon agent téléphonique ne répond plus au téléphone" }, { kind: "phrase", text: "Question sans rapport" },
    ], { blocks, now }, ports);
    expect(report.effects).toBe("none");
    expect(report.items.map(item => [item.ref, item.status, item.attribution?.outcome ?? null])).toEqual([
      ["email:msg-access-1", "ok", "block"], ["email:msg-refund-1", "ok", "team"], ["email:msg-missing", "mail_unreadable", null],
      ["phrase:4", "ok", "block"], ["phrase:5", "ok", "team"],
    ]);
    const first = report.items[0]!;
    expect(first.attribution).toMatchObject({ outcome: "block", blockId: "access", cardId: "card-login" });
    expect(first.topCards[0]).toMatchObject({ cardId: "card-login", blockId: "access", semanticScore: 0.86 });
    expect(first.topCards[0]!.rankingScore).toBeGreaterThan(first.topCards[1]!.rankingScore);
    // The quoted history (« facture ») is not the customer's new words: it neither triggers the sensitive rule nor enters the query.
    expect(calls[0]).not.toContain("facture");
    expect(report.items[1]!.attribution).toEqual({ outcome: "team", reason: "sensitive", families: ["finance"] });
    expect(report.items[3]!.attribution).toMatchObject({ blockId: "telephony" });
    expect(report.items[4]!.attribution).toMatchObject({ outcome: "team", reason: "no_block_card" });
    expect(report.totals).toMatchObject({ items: 5, failures: 1, decisionCalls: 0, decisionCostUsd: 0, byOutcome: { "block:access": 1, "block:telephony": 1, "team:sensitive": 1, "team:no_block_card": 1 } });
    for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
    expect(report.items.every(item => item.decision.status === "not_requested")).toBe(true);
  });

  it("imports no module able to send, write HubSpot or mutate a case (static proof of the read-only boundary)", () => {
    const forbidden = /gmail|hubspot|case-effect|executor|case-store|investigation-runner|customer-return|reply-passage|ledger|budget|lease|record|send|outbox/i;
    for (const file of ["block-replay.ts", "block-attribution.ts", "routing-measure.ts", "block-replay-ports.ts"]) {
      const source = readFileSync(path.join(__dirname, file), "utf8");
      const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(match => match[1]!);
      expect(imports.filter(target => forbidden.test(target)), file).toEqual([]);
    }
    const ports = readFileSync(path.join(__dirname, "block-replay-ports.ts"), "utf8");
    expect(ports).not.toMatch(/\.(insert|update|delete)\(|\.execute\(|transaction\(/);
  });

  it("reports a failing search on its item (retried once), never silently, and keeps going", async () => {
    const { backend, calls } = fakeSearch({ panne: undefined });
    const report = await runSavBlockReplay([{ kind: "phrase", text: "panne du serveur" }, { kind: "phrase", text: "je n'arrive pas à me connecter" }], { blocks, now }, { search: backend });
    expect(report.items[0]).toMatchObject({ status: "search_unavailable", searchAttempts: SAV_REPLAY_LIMITS.searchAttempts, attribution: null });
    expect(report.items[1]).toMatchObject({ status: "ok", attribution: { outcome: "block", blockId: "access" } });
    expect(calls).toHaveLength(3);
    expect(report.totals.failures).toBe(1);
  });

  it("never calls the model without the explicit flag, and stops at the budget", async () => {
    const { backend } = fakeSearch();
    const decide = vi.fn(async () => ({ action: "answer", reply: "Bonjour, voici la marche à suivre.", refusals: ["access_link_missing"], costUsd: 0.04 }));
    const phrases = Array.from({ length: 4 }, () => ({ kind: "phrase" as const, text: "je n'arrive pas à me connecter" }));
    const off = await runSavBlockReplay(phrases, { blocks, now }, { search: backend, decide });
    expect(decide).not.toHaveBeenCalled();
    expect(off.totals.decisionCalls).toBe(0);
    const on = await runSavBlockReplay(phrases, { blocks, now, decision: { enabled: true, maxCalls: 10, maxCostUsd: 0.1 } }, { search: backend, decide });
    expect(decide).toHaveBeenCalledTimes(3);
    expect(on.items.map(item => item.decision.status)).toEqual(["done", "done", "done", "skipped_budget"]);
    expect(on.items[0]!.decision).toMatchObject({ reply: "Bonjour, voici la marche à suivre.", refusals: ["access_link_missing"], costUsd: 0.04 });
    expect(on.totals.decisionCostUsd).toBeCloseTo(0.12);
    expect(on.totals.decisionSkippedBudget).toBe(1);
    await expect(runSavBlockReplay(phrases, { blocks, now, decision: { enabled: true, maxCalls: 1, maxCostUsd: 50 } }, { search: backend, decide })).rejects.toThrow("SAV_REPLAY_DECISION_BUDGET_INVALID");
    await expect(runSavBlockReplay(phrases, { blocks, now, decision: { enabled: true, maxCalls: 1, maxCostUsd: 1 } }, { search: backend })).rejects.toThrow("SAV_REPLAY_DECISION_PORT_MISSING");
  });

  it("refuses an ambiguous manifest before searching anything", async () => {
    const { backend, calls } = fakeSearch();
    const bad: SavBlockDraft[] = [...blocks, { blockId: "other", mode: "off", cardIds: ["card-login"] }];
    expect(savBlockManifestProblems(bad)).toEqual([{ code: "card_in_two_blocks", blockId: "other", cardId: "card-login" }]);
    await expect(runSavBlockReplay([{ kind: "phrase", text: "x" }], { blocks: bad, now }, { search: backend })).rejects.toThrow("card_in_two_blocks:other:card-login");
    expect(calls).toEqual([]);
  });
});

describe("attribution by cards", () => {
  const ranked = (cardId: string, blockId: string | null, rankingScore: number, semanticScore: number | null = 0.8): SavRankedCard =>
    ({ cardId, contentVersionId: `${cardId}-v1`, title: cardId, blockId, semanticScore, lexicalScore: 0, rankingScore });
  it("asks when two blocks are within the margin, sends to the team below the floor or on an exclusion", () => {
    expect(attributeSavBlockByCards("texte", [ranked("a", "access", 0.80), ranked("t", "telephony", 0.78)], blocks)).toEqual({ outcome: "ask", reason: "ambiguous", blockIds: ["access", "telephony"], score: 0.80, margin: expect.closeTo(0.02) });
    expect(attributeSavBlockByCards("texte", [ranked("a", "access", 0.80), ranked("t", "telephony", 0.70)], blocks)).toMatchObject({ outcome: "block", blockId: "access", secondBlockId: "telephony" });
    expect(attributeSavBlockByCards("texte", [ranked("a", "access", 0.6, 0.5)], blocks)).toMatchObject({ outcome: "team", reason: "below_floor" });
    expect(attributeSavBlockByCards("Comment inviter un collaborateur ?", [ranked("a", "access", 0.9)], blocks)).toMatchObject({ outcome: "team", reason: "excluded", exclusion: "inviter un collaborateur" });
    // A card of no block (support knowledge) ranked first does not block the attribution to the best block card.
    expect(attributeSavBlockByCards("texte", [ranked("s", null, 0.95), ranked("a", "access", 0.9)], blocks)).toMatchObject({ outcome: "block", blockId: "access" });
    // Finance anywhere wins over any card.
    expect(attributeSavBlockByCards("je n'arrive pas à me connecter et je veux résilier", [ranked("a", "access", 0.99)], blocks)).toMatchObject({ outcome: "team", reason: "sensitive", families: ["cancellation"] });
  });
});

describe("routing measurement (gate 2)", () => {
  const card = (cardId: string, blockId: string | null): SavRankedCard => ({ cardId, contentVersionId: "v", title: cardId, blockId, semanticScore: 0.8, lexicalScore: 0, rankingScore: 0.8 });
  const access = { outcome: "block" as const, blockId: "access", cardId: "card-login", score: 0.8, secondBlockId: null, margin: null };
  const team = { outcome: "team" as const, reason: "no_block_card" as const };
  it("computes the top-3 hit rate, the neighbour rejection rate, traps and overlaps exactly", () => {
    const results: SavRoutingPhraseResult[] = [
      // 18 positives: 17 with an access card in the top 3, 1 miss whose best card is telephony's (an overlap).
      ...Array.from({ length: 17 }, (_, i) => ({ phrase: { text: `p${i}`, kind: "positive" as const }, cards: [card("x", null), card("y", null), card("card-code", "access")], attribution: access })),
      { phrase: { text: "p-miss", kind: "positive" }, cards: [card("card-phone", "telephony"), card("x", null), card("y", null), card("card-login", "access")], attribution: team },
      // 10 neighbours: 9 rejected, 1 wrongly taken by access.
      ...Array.from({ length: 9 }, (_, i) => ({ phrase: { text: `n${i}`, kind: "neighbour" as const }, cards: [], attribution: team })),
      { phrase: { text: "n-taken", kind: "neighbour" }, cards: [], attribution: access },
      // 2 traps: one expected team (ok), one expected ask (got team).
      { phrase: { text: "t1", kind: "trap" }, cards: [], attribution: { outcome: "team", reason: "sensitive", families: ["finance"] } },
      { phrase: { text: "t2", kind: "trap", expected: "ask" }, cards: [], attribution: team },
    ];
    const m = measureSavBlockRouting(blocks[0]!, results);
    expect(m.phrases).toBe(30);
    expect(m.top3).toEqual({ hits: 17, total: 18, rate: 17 / 18 });
    expect(m.neighbourRejection).toEqual({ hits: 9, total: 10, rate: 0.9 });
    expect(m.traps).toEqual({ hits: 1, total: 2, rate: 0.5 });
    expect(m.overlaps).toEqual([{ text: "p-miss", otherBlockId: "telephony", cardId: "card-phone" }]);
    expect(m.gate).toEqual({ passed: false, reasons: ["trap_failed"] });
    // 17/18 = 94.4 % and 9/10 = 90 % both meet the 90 % gates; below that, the gate names the failure.
    const fewer = measureSavBlockRouting(blocks[0]!, results.slice(0, 18).concat(results.slice(18, 28)).filter(row => row.phrase.text !== "n0"));
    expect(fewer.neighbourRejection.rate).toBeCloseTo(8 / 9);
    expect(fewer.gate.reasons).toEqual(["neighbour_rejection_below_gate"]);
    expect(measureSavBlockRouting(blocks[0]!, []).gate.reasons).toEqual(["too_few_phrases:0<20", "top3_below_gate", "neighbour_rejection_below_gate"]);
  });

  it("measures a block's own test phrases end to end through the replay, without the model", async () => {
    const { backend } = fakeSearch();
    const phrases = [
      ...Array.from({ length: 18 }, (_, i) => ({ text: `je n'arrive pas à me connecter (${i})`, kind: "positive" as const })),
      ...Array.from({ length: 2 }, (_, i) => ({ text: `mon agent téléphonique est muet au téléphone (${i})`, kind: "neighbour" as const })),
      { text: "je n'arrive pas à me connecter pour payer ma facture", kind: "trap" as const },
    ];
    const withPhrases = blocks.map(block => block.blockId === "access" ? { ...block, testPhrases: phrases } : block);
    const m = await measureSavBlockTestPhrases("access", { blocks: withPhrases, now }, { search: backend });
    expect(m.top3).toEqual({ hits: 18, total: 18, rate: 1 });
    expect(m.neighbourRejection).toEqual({ hits: 2, total: 2, rate: 1 });
    expect(m.traps).toEqual({ hits: 1, total: 1, rate: 1 });
    expect(m.gate).toEqual({ passed: true, reasons: [] });
    expect(m.report.totals.decisionCalls).toBe(0);
  });
});
