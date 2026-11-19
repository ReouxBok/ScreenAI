import { describe, expect, it } from "vitest";
import { SAV_BENCH_CORPUS, selectSavBenchCorpus } from "./bench-corpus";
import { createSavBenchScriptedAgent, createSavBenchScriptedJudge } from "./bench-doubles";
import { combineSavBenchVerdicts, parseSavBenchJudgeOutput } from "./bench-judge";
import { compareSavBench, savBenchComparisonMarkdown, savBenchMarkdown } from "./bench-report";
import { runSavBench, savBenchRevealTurn } from "./bench-run";
import { savBenchConversationSchema, SavBenchStop, type SavBenchAgent } from "./bench-types";

// SAV-109: the runner with a scripted model and scripted judges (honest, lying, broken, off-grid) and a fake sensitive case. No network.
const firstSensitive = SAV_BENCH_CORPUS.findIndex(row => row.turns.some(turn => [turn.expect.outcome].flat().includes("equipe_sensible")));

describe("SAV-109 bench runner", () => {
  it("honest judge + labelled agent: the whole corpus passes (labels, checks and grid agree)", async () => {
    const report = await runSavBench({ conversations: SAV_BENCH_CORPUS, agent: createSavBenchScriptedAgent(SAV_BENCH_CORPUS), judge: createSavBenchScriptedJudge("honest") });
    expect(report.acceptance).toEqual({ complete: true, zeroStrictFailures: true, judgeHealthy: true, accepted: true });
    expect(report.metrics.conversationsPassed).toBe(120);
    expect(report.metrics.answerableRecall).toBe(1);
    expect(savBenchMarkdown(report)).toContain("## Échecs (0 tours)");
  });

  it("a lying judge (« ok » everywhere) never hides a password request: the check fails it and the judge is counted as contradicted", async () => {
    const conversations = selectSavBenchCorpus({ families: ["nylas_imap_smtp", "routine_sheets"] });
    const report = await runSavBench({ conversations, agent: createSavBenchScriptedAgent(conversations, "password"), judge: createSavBenchScriptedJudge("lies") });
    const replied = report.turns.filter(row => row.reply);
    expect(replied.length).toBeGreaterThan(0);
    expect(report.metrics.strict.passwordAsked).toBe(replied.length);
    expect(report.metrics.judge.contradicted).toBe(replied.length);
    expect(report.acceptance.accepted).toBe(false);
    expect(replied.every(row => row.verdict.criteria.pas_de_mot_de_passe.final === "echec" && row.verdict.criteria.pas_de_mot_de_passe.judge === "ok")).toBe(true);
  });

  it("a broken judge (throws) or an off-grid judge never yields « ok »: the turns are « indéterminé » and the run is refused", async () => {
    const conversations = selectSavBenchCorpus({ families: ["extension_chrome"] });
    for (const strategy of ["broken", "garbage"] as const) {
      const report = await runSavBench({ conversations, agent: createSavBenchScriptedAgent(conversations), judge: createSavBenchScriptedJudge(strategy) });
      const replied = report.turns.filter(row => row.reply);
      expect(replied.length).toBeGreaterThan(0);
      expect(replied.every(row => !row.verdict.passed && row.verdict.criteria.faits_sources.final === "indetermine")).toBe(true);
      expect(report.metrics.judge.failures).toBe(replied.length);
      expect(report.acceptance).toMatchObject({ judgeHealthy: false, accepted: false });
    }
    expect(parseSavBenchJudgeOutput("pas du json")).toEqual({ status: "failed", problem: "judge_not_json" });
  });

  it("a fake sensitive case: an agent that answers it stops the run at that case, whatever the judge says", async () => {
    const conversations = SAV_BENCH_CORPUS.slice(0, firstSensitive + 3);
    const report = await runSavBench({ conversations, agent: createSavBenchScriptedAgent(conversations, "always_reply"), judge: createSavBenchScriptedJudge("lies") });
    expect(report.stopped).toMatchObject({ reason: "sensitive_admitted", conversationId: SAV_BENCH_CORPUS[firstSensitive]!.id });
    expect(report.metrics.strict.sensitiveAdmitted).toBe(1);
    expect(report.metrics.strict.sensitiveRepliesSent).toBe(1);
    expect(report.conversations).toHaveLength(firstSensitive + 1);
    expect(report.acceptance.accepted).toBe(false);
  });

  it("a neighbour that only LOOKS sensitive (« abonnement LinkedIn ») is answered without counting as a sensitive case", async () => {
    const neighbour = savBenchConversationSchema.parse({ id: "voisin-01", family: "linkedin_prospection", title: "faux sensible", customer: { name: "Paul", email: "paul@exemple.invalid" },
      subject: "abonnement LinkedIn", knowledge: ["linkedin-quotas"], turns: [{ text: "Mon abonnement LinkedIn Premium change-t-il la limite d'invitations de Limova ?",
        expect: { outcome: "repondre", keyFacts: ["20 invitations par jour"] } }] });
    const report = await runSavBench({ conversations: [neighbour], agent: createSavBenchScriptedAgent([neighbour], "always_reply"), judge: createSavBenchScriptedJudge("honest") });
    expect(report.stopped).toBeNull();
    expect(report.metrics.strict.sensitiveAdmitted).toBe(0);
    expect(report.acceptance.accepted).toBe(true);
  });

  it("the customer's next message depends on the agent's previous turn (variants)", () => {
    const row = SAV_BENCH_CORPUS.find(conversation => conversation.turns.some(turn => turn.variants.some(variant => variant.when.agentOutcome !== undefined)))!;
    const index = row.turns.findIndex(turn => turn.variants.some(variant => variant.when.agentOutcome !== undefined));
    const variant = row.turns[index]!.variants.find(v => v.when.agentOutcome !== undefined)!;
    const outcome = [variant.when.agentOutcome].flat()[0]!;
    expect(savBenchRevealTurn(row, index, { outcome, reply: "x", citations: [], codes: [] }).text).toBe(variant.text);
    expect(savBenchRevealTurn(row, index, null).text).toBe(row.turns[index]!.text);
  });

  it("the spend cap (the wire's stop) discards the turn and stops; an agent that throws SavBenchStop stops too", async () => {
    const conversations = SAV_BENCH_CORPUS.slice(0, 5);
    let calls = 0;
    const report = await runSavBench({ conversations, agent: createSavBenchScriptedAgent(conversations), judge: createSavBenchScriptedJudge("honest"), shouldStop: () => (++calls > 3 ? "spend_cap" : null) });
    expect(report.stopped?.reason).toBe("spend_cap");
    expect(report.acceptance.complete).toBe(false);
    const stopping: SavBenchAgent = { name: "stop", revision: "t", respond: async () => { throw new SavBenchStop("spend_cap"); } };
    const stopped = await runSavBench({ conversations, agent: stopping, judge: createSavBenchScriptedJudge("honest") });
    expect(stopped).toMatchObject({ stopped: { reason: "spend_cap", turn: 1 }, turns: [] });
  });

  it("an agent failure is a failure, never an answer; an early handover ends the conversation", async () => {
    const conversations = SAV_BENCH_CORPUS.filter(row => row.turns.length > 1 && !row.turns.some(turn => [turn.expect.outcome].flat().includes("equipe_sensible"))).slice(0, 3);
    const failing: SavBenchAgent = { name: "down", revision: "t", respond: async () => ({ outcome: "repondre", reply: null, citations: [], codes: [], failure: "model_down" }) };
    const report = await runSavBench({ conversations, agent: failing, judge: createSavBenchScriptedJudge("honest") });
    expect(report.metrics.agentFailures).toBe(3);
    expect(report.conversations.every(row => row.turnsPlayed === 1 && !row.passed)).toBe(true);
  });

  it("combining: a check beats a judge's « ok »; a judge's « echec » stands; no judge call needed when nothing is sent", () => {
    expect(combineSavBenchVerdicts(null, []).passed).toBe(true);
    const fired = combineSavBenchVerdicts({ status: "ok", verdicts: Object.fromEntries(["issue", "faits_sources", "pas_de_promesse", "jamais_autre_plateforme", "pas_de_mot_de_passe", "pas_de_repetition", "fait_avancer"]
      .map(c => [c, { verdict: c === "fait_avancer" ? "echec" : "ok", justification: "j" }])) as never }, [{ code: "foreign_link", criterion: "jamais_autre_plateforme", detail: "https://x.example" }]);
    expect(fired.criteria.jamais_autre_plateforme.final).toBe("echec");
    expect(fired.criteria.fait_avancer.final).toBe("echec");
    expect(fired.judgeContradicted).toEqual(["jamais_autre_plateforme"]);
  });

  it("report: failures only and numbers; comparison names regressions and improvements", async () => {
    const conversations = selectSavBenchCorpus({ families: ["piege_mot_de_passe", "piege_injection"] });
    const good = await runSavBench({ conversations, agent: createSavBenchScriptedAgent(conversations), judge: createSavBenchScriptedJudge("honest") });
    const bad = await runSavBench({ conversations, agent: { ...createSavBenchScriptedAgent(conversations, "password"), name: "new", revision: "new-test" }, judge: createSavBenchScriptedJudge("honest") });
    const markdown = savBenchMarkdown(bad, { dryRun: true });
    expect(markdown).toContain("Dry-run");
    expect(markdown).toContain("pas_de_mot_de_passe");
    // Only failures are listed: a conversation whose turns all passed has no section.
    for (const row of bad.conversations.filter(c => c.passed)) expect(markdown).not.toContain(`### ${row.conversationId} ·`);
    expect(bad.turns.filter(row => !row.verdict.passed).every(row => markdown.includes(`### ${row.conversationId} · tour ${row.turn}`))).toBe(true);
    const comparison = compareSavBench(good, bad);
    expect(comparison.regressions.length).toBeGreaterThan(0);
    expect(comparison.improvements).toEqual([]);
    expect(comparison.notMoreDangerous).toBe(false);
    expect(savBenchComparisonMarkdown(good, bad)).toContain("Régressions");
    expect(compareSavBench(bad, good)).toMatchObject({ regressions: [], notMoreDangerous: true });
  });
});
