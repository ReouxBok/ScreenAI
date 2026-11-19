import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACCESS_SKILL_TEST_PROVIDER_ENV } from "../../../../../test/sav-access-skill-double";
import { SAV_BENCH_CORPUS } from "../../bench/bench-corpus";
import { savBenchConversationSchema, type SavBenchAgentInput } from "../../bench/bench-types";
import { accessSkillWireAnswer } from "../access-skill/access-skill-wire";
import { createSavBenchAgent } from "./smart-bench-agent";
import { SAV_SMART_BENCH_MULTITURN } from "./smart-bench-multiturn.fixture";
import { importGraph } from "./smart-import-graph.testkit";
import { SMART_CONFORME, smartGoodDecision, smartReading } from "./smart-test-doubles";

/*
 * Bench (20/11): the 12 multi-turn conversations of the new agent, and the bench agent on the NEW loop with the case memory kept across turns.
 * The model is doubled at the network (Gemini wire), no key, no money. Fictional data only.
 */
const here = path.dirname(fileURLToPath(import.meta.url)), src = path.resolve(here, "../../../..");

describe("corpus multi-tours (mémoire et règle de progrès)", () => {
  it("12 conversations valides, toutes multi-tours, identifiants distincts des 120 du banc", () => {
    expect(SAV_SMART_BENCH_MULTITURN).toHaveLength(12);
    for (const row of SAV_SMART_BENCH_MULTITURN) {
      expect(savBenchConversationSchema.safeParse(row).success).toBe(true);
      expect(row.turns.length).toBeGreaterThanOrEqual(2);
      expect(row.customer.email).toMatch(/@exemple\.invalid$/);
    }
    const ids = [...SAV_BENCH_CORPUS, ...SAV_SMART_BENCH_MULTITURN].map(row => row.id);
    expect(new Set(ids).size).toBe(132);
    expect(SAV_BENCH_CORPUS).toHaveLength(120);
  });
  it("les cas de progrès finissent par un passage de main attendu ; un cas va jusqu'au 5e échange", () => {
    const progress = SAV_SMART_BENCH_MULTITURN.filter(row => row.id.startsWith("multi-progres") && !["multi-progres-02"].includes(row.id));
    expect(progress.length).toBeGreaterThanOrEqual(5);
    for (const row of progress) expect([row.turns.at(-1)!.expect.outcome].flat()).toEqual(["passer_la_main"]);
    expect(SAV_SMART_BENCH_MULTITURN.some(row => row.turns.length === 5)).toBe(true);
  });
});

describe("l'agent « new » du banc utilise la nouvelle boucle et garde la mémoire du fil", () => {
  /** The model at the network: understand, then a final step proposing a trial, then the counter-read. */
  function network() {
    const kinds: string[] = [], decides: Array<{ memory: { exchange: number; trials: unknown[] }; noProgressLastTurn: boolean; lastStep: boolean }> = [];
    const fn = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)), system: string = body.systemInstruction.parts[0].text, payload = JSON.parse(body.contents[0].parts[0].text);
      const kind = system.startsWith("Tu lis un mail") ? "understand" : system.startsWith("RELECTURE") ? "verify" : "decide";
      kinds.push(kind);
      if (kind === "decide") decides.push(payload);
      const trial = { id: `e${decides.length}`, needId: "n1", what: `Essai numéro ${decides.length} sur la connexion`, cardId: "fiche-connexion" };
      const output = kind === "understand" ? smartReading() : kind === "verify" ? SMART_CONFORME
        : { thinking: "je propose un essai", action: "final", calls: [], decision: smartGoodDecision({ memory: { trials: [trial] }, facts: [{ ...smartGoodDecision().facts[0], version: "v1" }] }) };
      return Response.json(accessSkillWireAnswer(output, { inputTokens: 1_000, outputTokens: 200 }));
    };
    return { fn, kinds, decides };
  }
  const card = { id: "fiche-connexion", title: "Se connecter à Limova", content: "Pour vous connecter, utilisez l'adresse e-mail de votre invitation. Si le code n'arrive pas, vérifiez le dossier des indésirables.", steps: [] };
  const input = (turn: number, texts: string[]): SavBenchAgentInput => ({ conversationId: "conv-test", turn, family: "piege_toujours_pareil", subject: "connexion", customer: { name: "Test Fictif", email: "test@exemple.invalid" },
    messages: texts.map((text, index) => ({ from: index % 2 === 0 ? "client" as const : "agent" as const, text, at: `2026-11-20T09:0${index}:00.000Z` })), knowledge: [card], now: "2026-11-20T10:00:00.000Z" });

  it("3 tours « toujours pareil » : réponse, réponse, puis passage de main (2 tours sans progrès) ; la mémoire passe d'un tour à l'autre", async () => {
    const net = network(), agent = createSavBenchAgent({ dryRun: false, network: net.fn, env: ACCESS_SKILL_TEST_PROVIDER_ENV });
    const first = "Bonjour, je n'arrive pas à me connecter, le code n'arrive pas.";
    const t1 = await agent.respond(input(1, [first]));
    const t2 = await agent.respond(input(2, [first, t1.reply ?? "", "Toujours pareil."]));
    const t3 = await agent.respond(input(3, [first, t1.reply ?? "", "Toujours pareil.", t2.reply ?? "", "Toujours pareil."]));
    expect([t1.outcome, t2.outcome, t3.outcome]).toEqual(["repondre", "repondre", "passer_la_main"]);
    expect(t3.codes).toContain("progress:no_progress");
    expect(net.decides.map(row => row.memory.exchange)).toEqual([1, 2, 3]);
    expect(net.decides[1]!.memory.trials).toHaveLength(1);
    expect(net.decides[2]!.noProgressLastTurn).toBe(true);
    // A new conversation (turn 1) starts from an empty memory.
    await agent.respond(input(1, [first]));
    expect(net.decides.at(-1)!.memory.exchange).toBe(1);
  });
  it("le module du banc n'atteint pas le client Academy à l'exécution (injecté par l'auto-test serveur seulement)", () => {
    const graph = [...importGraph(path.join(here, "smart-bench-agent.ts"), src).keys()].map(file => path.relative(src, file).split(path.sep).join("/"));
    expect(graph).not.toContain("lib/sav/cases/smart/tools/academy.ts");
    expect(graph).toContain("lib/sav/cases/smart/smart-tools.ts");
  });
});
