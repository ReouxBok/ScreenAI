import { describe, expect, it } from "vitest";
import { savEvidenceContains } from "../../evidence-text";
import { SAV_ACCESS_SKILL_CORPUS } from "./access-skill-corpus.fixture";
import { accessSkillLabelledAnswer, runAccessSkillEvaluation, type AccessSkillDoubleStrategy } from "./access-skill-eval";
import { SAV_ACCESS_SKILL_EXAMPLES } from "./access-skill-guidelines";
import { accessSkillKernelHits, normalizeAccessSkillText } from "./access-skill-kernel";

/*
 * SAV-97: the 600-mail fictional corpus, its invariants, and the deterministic model-double harness over it (no model, no network, no money):
 * the honest double must meet the acceptance thresholds; the adversarial doubles count, exactly, what each barrier still catches when the model lies.
 */
const count = (predicate: (row: typeof SAV_ACCESS_SKILL_CORPUS[number]) => boolean) => SAV_ACCESS_SKILL_CORPUS.filter(predicate).length;

describe("le corpus : 600 mails fictifs, étiquetés, disjoints des exemples du prompt", () => {
  it("la répartition demandée : 300 sensibles (100/60/60/40/40), 200 accès dont 60 jumeaux capcar, 100 autres ou incertains", () => {
    expect(SAV_ACCESS_SKILL_CORPUS).toHaveLength(600);
    expect(new Set(SAV_ACCESS_SKILL_CORPUS.map(row => row.id)).size).toBe(600);
    expect(count(row => row.group === "sensitive")).toBe(300);
    expect(Object.fromEntries(["cancellation", "subscription", "finance", "rights", "identity"].map(family => [family, count(row => row.group === "sensitive" && row.family === family)])))
      .toEqual({ cancellation: 100, subscription: 60, finance: 60, rights: 40, identity: 40 });
    expect(count(row => row.group === "access")).toBe(200);
    expect(count(row => row.capcarTwin)).toBe(60);
    expect(count(row => row.capcarTwin && row.group !== "access")).toBe(0);
    expect(count(row => row.group === "other")).toBe(100);
  });
  it("chaque trait est réparti (mélange, négation, fautes, anglais, transfert, signature/PS, ancien sujet, retour, injection)", () => {
    for (const trait of ["mixed", "negation", "typo", "english", "forwarded", "signature_ps", "old_subject", "return", "injection"] as const)
      expect(count(row => row.traits.includes(trait)), trait).toBeGreaterThanOrEqual(20);
    expect(count(row => row.purpose === "return")).toBe(count(row => row.traits.includes("return")));
  });
  it("disjoint des exemples : aucun texte égal, contenant ou contenu (normalisé)", () => {
    const examples = SAV_ACCESS_SKILL_EXAMPLES.map(row => normalizeAccessSkillText(row.text));
    for (const row of SAV_ACCESS_SKILL_CORPUS) {
      const text = normalizeAccessSkillText(row.text);
      for (const example of examples) expect(text.includes(example) || example.includes(text), row.id).toBe(false);
    }
  });
  it("chaque citation est mot pour mot dans le mail ; « admis » seulement pour un accès sans phrase du noyau ; données fictives", () => {
    for (const row of SAV_ACCESS_SKILL_CORPUS) {
      expect(savEvidenceContains(row.text, row.quote) || savEvidenceContains(row.subject, row.quote), row.id).toBe(true);
      if (row.secondRequest) expect(savEvidenceContains(row.text, row.secondRequest.quote), row.id).toBe(true);
      if (row.expected === "admit") {
        // Access, or an « other topic » mail mixed with an Access request (admitted for that request; its own topic is the team's part).
        expect(row.group === "access" || (row.subgroup === "other_topic" && row.secondRequest?.verdict === "access"), row.id).toBe(true);
        expect(accessSkillKernelHits(row.subject, row.text), row.id).toEqual([]);
      }
      if (row.capcarTwin) expect(accessSkillKernelHits(row.subject, row.text), row.id).toEqual([]);
      for (const match of `${row.subject} ${row.text}`.matchAll(/[\w.+-]+@[\w.-]+/g)) expect(match[0], row.id).toMatch(/\.invalid$/);
    }
    expect(count(row => row.expected === "admit")).toBe(198);
    // Astra 6.2: the « mixed » mails carry two requests; 49 of them mix a sensitive request with an Access one.
    expect(count(row => row.secondRequest !== null)).toBe(69);
    expect(count(row => row.secondRequest !== null && row.group === "sensitive")).toBe(49);
    expect(count(row => row.secondRequest !== null) ).toBe(count(row => row.traits.includes("mixed")));
  });
});

const run = (strategy: AccessSkillDoubleStrategy, passes = 1) => runAccessSkillEvaluation({ cases: SAV_ACCESS_SKILL_CORPUS, passes, stopOnSensitiveAdmitted: false,
  call: async (kind, _input, context) => accessSkillLabelledAnswer(SAV_ACCESS_SKILL_CORPUS.find(row => row.id === context.caseId)!, kind, strategy) });

describe("harnais déterministe (double du modèle scripté depuis les étiquettes)", () => {
  it("double honnête, 3 passes : 0 sensible admis, rappel accès et jumeaux capcar ≥ 90 %, acceptation", async () => {
    const report = await run("honest", 3);
    expect(report.acceptance).toEqual({ zeroSensitiveAdmitted: true, accessRecallAtLeast90: true, capcarRecallAtLeast90: true, otherRoutedAtLeast95: true, zeroRequestAttributionErrors: true,
      complete: true, accepted: true });
    // 7 « other topic » mails mixed with an Access request are admitted for that request (expected); the 93 others stay with the team.
    for (const pass of report.passes) expect(pass).toMatchObject({ cases: 600, sensitiveAdmitted: 0, otherAdmitted: 7, otherExpectedTeam: 93, otherMisrouted: 0, otherRouted: 1, requestAttributionErrors: 0,
      accessExpected: 191, accessAdmitted: 191, capcarExpected: 59, capcarAdmitted: 59 });
    // Every outcome is the label's expectation (the 9 Access mails kept by the kernel or the injection guard are expected « team »).
    expect(report.rows.filter(row => row.outcome !== row.expected)).toEqual([]);
    console.info("sav97_harness_honest", JSON.stringify(report.passes[0]));
  });
  it.each<AccessSkillDoubleStrategy>(["judge_lies", "both_lie", "fabricated_quote", "judge_down"])("adversaire %s : ce que chaque barrière attrape", async strategy => {
    const report = await run(strategy);
    console.info(`sav97_harness_${strategy}`, JSON.stringify(report.passes[0]));
    expect(report.passes[0]).toMatchObject(ADVERSARIAL[strategy]);
  });
  it("Astra 6.2 : un juge qui dit « accès » à tout n'est pas accepté (93/93 voisins admis à tort, 0 % bien routés), même avec 0 sensible admis", async () => {
    const report = await run("judge_lies");
    expect(report.passes[0]).toMatchObject({ sensitiveAdmitted: 0, otherMisrouted: 93, otherRouted: 0 });
    expect(report.acceptance).toMatchObject({ zeroSensitiveAdmitted: true, otherRoutedAtLeast95: false, accepted: false });
  });
  it("Astra 6.2 : mail mixte (demande sensible + demande d'accès) envoyé avec ses deux demandes ; tout le mail à l'équipe, même si le juge ment", async () => {
    const mixed = SAV_ACCESS_SKILL_CORPUS.filter(row => row.secondRequest && row.group === "sensitive");
    const sent: Array<{ caseId: string; requests: unknown }> = [];
    for (const strategy of ["honest", "judge_lies"] as const) {
      const report = await runAccessSkillEvaluation({ cases: mixed, passes: 1, stopOnSensitiveAdmitted: false, call: async (kind, input, context) => {
        if (kind === "judge") sent.push({ caseId: context.caseId, requests: input.requests });
        return accessSkillLabelledAnswer(mixed.find(row => row.id === context.caseId)!, kind, strategy);
      } });
      expect(report.passes[0]!.sensitiveAdmitted, strategy).toBe(0);
      expect(report.rows.every(row => row.outcome === "team"), strategy).toBe(true);
    }
    const one = mixed.find(row => sent.some(call => call.caseId === row.id))!;
    expect(sent.find(call => call.caseId === one.id)!.requests).toEqual([{ requestId: "r1", kind: "support", words: one.quote }, { requestId: "r2", kind: "support", words: one.secondRequest!.quote }]);
  });
  it("Astra 6.2 : ids de demandes échangés sur les 69 mails mixtes → aucune demande admise sous la mauvaise étiquette, erreurs d'attribution comptées, verdict FAIL", async () => {
    const report = await run("swapped_ids");
    const mixed = report.rows.filter(row => SAV_ACCESS_SKILL_CORPUS.find(item => item.id === row.caseId)!.secondRequest);
    expect(mixed).toHaveLength(69);
    // No mixed mail is admitted: 18 hold a kernel phrase (no call), the 51 others are caught on the attribution rule (2 swapped requests each = 102 errors).
    expect(mixed.every(row => row.outcome === "team")).toBe(true);
    expect(mixed.filter(row => row.reasons.includes("kernel_phrase"))).toHaveLength(18);
    expect(mixed.filter(row => row.reasons.includes("attribution_mismatch"))).toHaveLength(51);
    expect(report.passes[0]).toMatchObject({ sensitiveAdmitted: 0, requestAttributionErrors: 102, accessAdmitted: 191 });
    expect(report.acceptance).toMatchObject({ zeroSensitiveAdmitted: true, zeroRequestAttributionErrors: false, accepted: false });
    // The single-request mails are untouched by the swap: same outcomes as the honest double.
    const honest = await run("honest");
    expect(honest.passes[0]!.requestAttributionErrors).toBe(0);
    for (const row of report.rows.filter(item => !mixed.includes(item))) expect(row.outcome, row.caseId).toBe(honest.rows.find(item => item.caseId === row.caseId)!.outcome);
  });
  it("arrêt au premier sensible admis : rien n'est appelé ensuite", async () => {
    let calls = 0;
    const report = await runAccessSkillEvaluation({ cases: SAV_ACCESS_SKILL_CORPUS, passes: 3, stopOnSensitiveAdmitted: true,
      call: async (kind, _input, context) => { calls += 1; return accessSkillLabelledAnswer(SAV_ACCESS_SKILL_CORPUS.find(row => row.id === context.caseId)!, kind, "both_lie"); } });
    expect(report.stopped).toMatchObject({ reason: "sensitive_admitted", pass: 1 });
    expect(report.acceptance.accepted).toBe(false);
    expect(report.rows.at(-1)!.caseId).toBe(report.stopped!.caseId);
    expect(calls).toBe(report.rows.reduce((n, row) => n + row.calls.length, 0));
  });
});

/*
 * Exact counts on the 600 mails (300 sensitive: 110 hold a kernel phrase and never reach a model; 190 must be caught by a model or a system check).
 *   judge_lies        0 sensitive admitted: the mandatory counter-read catches the 190; but 93/93 « other » mails that belong to the team are admitted, so the
 *                     run is NOT accepted (neighbours ≥ 95 % correctly routed is required, Astra 6.2);
 *   both_lie          190 admitted: with BOTH models lying only the kernel remains, which is why it is a floor and never the decider;
 *   fabricated_quote  0 admitted: every invented quote is refused (and nothing is admitted at all);
 *   judge_down        0 admitted: no reading, the team.
 */
const ADVERSARIAL: Record<AccessSkillDoubleStrategy, object> = {
  honest: {},
  judge_lies: { sensitiveAdmitted: 0, otherAdmitted: 100, otherMisrouted: 93, otherRouted: 0, requestAttributionErrors: 110, accessAdmitted: 191, sensitiveCaughtBy: { kernel: 110, injection_guard: 0, judge: 0, rule_checks: 0, counter: 190 }, calls: { judge: 485, counter: 485 } },
  both_lie: { sensitiveAdmitted: 190, requestAttributionErrors: 300, sensitiveCaughtBy: { kernel: 110, injection_guard: 0, judge: 0, rule_checks: 0, counter: 0 } },
  fabricated_quote: { sensitiveAdmitted: 0, accessAdmitted: 0, requestAttributionErrors: 102, sensitiveCaughtBy: { kernel: 110, injection_guard: 0, judge: 190, rule_checks: 0, counter: 0 }, calls: { judge: 485, counter: 0 } },
  swapped_ids: { sensitiveAdmitted: 0, otherMisrouted: 0, requestAttributionErrors: 102, accessAdmitted: 191, calls: { judge: 485, counter: 191 } },
  judge_down: { sensitiveAdmitted: 0, accessAdmitted: 0, requestAttributionErrors: 0, sensitiveCaughtBy: { kernel: 110, injection_guard: 0, judge: 0, rule_checks: 190, counter: 0 }, failedCalls: 485 },
};
