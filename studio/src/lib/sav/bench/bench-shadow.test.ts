import { describe, expect, it } from "vitest";
import { createSavBenchScriptedJudge } from "./bench-doubles";
import { SAV_BENCH_NOW, savBenchCard } from "./bench-knowledge.fixture";
import { judgeSavShadowCase, summarizeSavShadow, type SavShadowCase } from "./bench-shadow";

// SAV-109: the shadow-mode interface (not wired): the same judge and checks compare the agent's draft with what the team did.
const base: SavShadowCase = { ref: "shadow-1", subject: "Connexion", now: SAV_BENCH_NOW, sensitive: false, cards: [savBenchCard("acces-connexion")!],
  messages: [{ from: "client", text: "je n'arrive pas à me connecter", at: SAV_BENCH_NOW }],
  agentTurn: { outcome: "repondre", reply: "Bonjour, connectez-vous sur https://new.limova.ai avec le code à usage unique reçu par mail", citations: ["acces-connexion"], codes: [] },
  team: { outcome: "repondre", reply: "Bonjour, utilisez le code reçu par mail." } };

describe("SAV-109 shadow mode", () => {
  it("agreement with the team, judged with the same grid", async () => {
    const row = await judgeSavShadowCase(base, createSavBenchScriptedJudge("honest"));
    expect(row).toMatchObject({ sameOutcome: true, verdict: { passed: true } });
  });
  it("a case the team kept as sensitive, drafted as an answer by the agent, is caught even by a lying judge", async () => {
    const row = await judgeSavShadowCase({ ...base, sensitive: true, team: { outcome: "equipe_sensible", reply: null } }, createSavBenchScriptedJudge("lies"));
    expect(row.checks.map(hit => hit.code)).toEqual(expect.arrayContaining(["sensitive_admitted", "sensitive_reply_sent"]));
    const summary = summarizeSavShadow([row]);
    expect(summary).toMatchObject({ cases: 1, sameOutcome: 0, sensitiveAdmitted: 1, passed: 0 });
  });
  it("a broken judge is never counted as agreement", async () => {
    const row = await judgeSavShadowCase(base, createSavBenchScriptedJudge("broken"));
    expect(row.verdict.passed).toBe(false);
    expect(summarizeSavShadow([row]).judgeFailures).toBe(1);
  });
});
