import { describe, expect, it } from "vitest";
import { emptyCaseBody, type CaseBody } from "./case-types";
import { buildCaseHandoffSummary, caseHandoffExchangeLines, CASE_HANDOFF_SUMMARY_LIMITS } from "./case-handoff-summary";
import { handoffNoticeFacts, renderHandoffNotice, sanitizeNoticeText, scrubHandoffNoticeText } from "./case-handoff-notice";

/* SAV-92 (Ugo 14/11): the handoff synthesis, SYN data only. */
const AT = (m: number) => `2026-11-14T08:${String(m).padStart(2, "0")}:00.000Z`;
const email = (id: string) => ({ type: "email" as const, id });
function body(over: Partial<CaseBody> = {}): CaseBody {
  return { ...emptyCaseBody(),
    openRequests: [{ id: "r1", summary: "Demande support", family: "access", status: "open", openedAt: AT(0),
      subject: { status: "available", text: "Connexion impossible à la plateforme.", provenance: { source: "v1_accepted_analysis", field: "ticketSummary",
        runId: "30000000-0000-4000-8000-000000000001", runVersion: 1, resultHash: "h", validatorRevision: "v", acceptedAt: AT(0) } } }],
    facts: [
      { id: "f1", text: "Je n'arrive plus à me connecter, mon mot de passe Soleil2024! est refusé, appelez-moi au 06 12 34 56 78.", source: email("gm-1"), at: AT(1), key: null, kind: "customer_statement" },
      { id: "f2", text: "Le message affiché est « compte verrouillé », voici la conversation https://app.example.invalid/chat/abc?token=xyz", source: email("gm-2"), at: AT(5), key: null, kind: "customer_statement" },
      { id: "f3", text: "Capture de l'écran d'erreur", source: { type: "attachment", id: "gm-2:1" }, at: AT(5), key: null, kind: "observed" },
    ],
    questions: [
      { id: "q1", text: "Quel message s'affiche à l'écran ?", factKeys: [], askedAt: AT(2), askedInEffect: "e1", answeredBy: email("gm-2") },
      { id: "q2", text: "Depuis quel navigateur ?", factKeys: [], askedAt: AT(6), askedInEffect: "e2" },
    ],
    trials: [{ id: "t1", requestId: "r1", procedure: { knowledgeId: "syn-login", contentVersionId: "syn-login-v1" }, askedAt: AT(3), outcome: "failed", resultAt: AT(5),
      result: { text: "Toujours verrouillé après réinitialisation.", source: email("gm-2") } }],
    ...over } as CaseBody;
}

describe("handoff synthesis (stored case only, masked, bounded)", () => {
  it("carries the first customer words, the questions and answers, what was transmitted, the trials; secrets and phone numbers masked", () => {
    const summary = buildCaseHandoffSummary(body());
    expect(summary.problem.source).toBe("customer_words");
    expect(summary.problem.text).toContain("Je n'arrive plus à me connecter");
    expect(summary.problem.text).not.toMatch(/Soleil2024|06 12 34/);
    expect(summary.exchanges).toEqual([
      { question: "Quel message s'affiche à l'écran ?", answered: true, answer: expect.stringContaining("compte verrouillé"), customerWroteAfter: true },
      { question: "Depuis quel navigateur ?", answered: false, answer: null, customerWroteAfter: false },
    ]);
    expect(summary.exchanges[0]!.answer).not.toContain("token=xyz");
    expect(summary.transmitted).toEqual({ attachments: 1, links: 1, linkHosts: ["app.example.invalid"], urlsMasked: 1 });
    expect(summary.tried).toEqual([{ knowledgeId: "syn-login", outcome: "failed", result: "Toujours verrouillé après réinitialisation." }]);
    const lines = caseHandoffExchangeLines(summary);
    expect(lines).toContain("• Agent : Depuis quel navigateur ? → pas encore de réponse du client");
    expect(lines[0]).toMatch(/^• Agent : Quel message s'affiche à l'écran \? → réponse du client : .*compte verrouillé/);
  });

  it("without customer words: V1's subject; without anything: says so; nothing transmitted and nothing tried are stated", () => {
    expect(buildCaseHandoffSummary(body({ facts: [] })).problem).toEqual({ source: "v1_subject", text: "Connexion impossible à la plateforme." });
    const bare = buildCaseHandoffSummary({ ...emptyCaseBody() });
    expect(bare.problem).toEqual({ source: "none", text: null });
    expect(caseHandoffExchangeLines(bare)).toEqual([]);
  });

  it("bounded: long texts are cut, older questions and trials counted", () => {
    const long = "mot ".repeat(1000);
    const many = body({
      facts: [{ id: "f1", text: long, source: email("gm-1"), at: AT(1), key: null, kind: "customer_statement" }],
      questions: Array.from({ length: 9 }, (_, i) => ({ id: `q${i}`, text: `${i} ${long}`, factKeys: [], askedAt: AT(10 + i), askedInEffect: `e${i}`, answeredBy: email("gm-1") })),
      trials: Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, requestId: "r1", procedure: { knowledgeId: `k${i}`, contentVersionId: "v" }, askedAt: AT(i), outcome: "pending" as const, resultAt: null })),
    });
    const summary = buildCaseHandoffSummary(many);
    expect(summary.problem.text!.length).toBeLessThanOrEqual(CASE_HANDOFF_SUMMARY_LIMITS.problemChars);
    expect(summary.exchanges).toHaveLength(CASE_HANDOFF_SUMMARY_LIMITS.questions);
    expect(summary.exchangesOmitted).toBe(4);
    expect(summary.triedOmitted).toBe(3);
    const lines = caseHandoffExchangeLines(summary);
    expect(lines).toHaveLength(CASE_HANDOFF_SUMMARY_LIMITS.questions + 1);
    expect(lines.at(-1)).toBe("• et 4 question(s) plus ancienne(s)");
  });

  it("the Slack notice reads the exchanges from the synthesis (channel-cleaned), keeps the marker, and re-scrubbing changes nothing", () => {
    const trigger = { ok: true as const, caseId: "10000000-0000-4000-8000-000000000001", ticketId: "9500001", inputKey: "in:gm-2", recordedAtVersion: 4, reason: "explicit_human_request" as const,
      report: { need: "Le client ne peut plus se connecter.", expected: null, observed: null, trialIds: ["t1"], hypotheses: [], missingInformation: [], expectedIntervention: "Rappeler le client." } };
    const facts = handoffNoticeFacts(trigger, body());
    const render = renderHandoffNotice(facts, { contact: { status: "unverified", why: "no_matching_contact" }, ticket: { status: "verified", id: "9500001" } }, "1234567");
    expect(render.text).toContain("• Agent : Quel message s'affiche à l'écran ? → réponse du client : ");
    expect(render.text).toContain("• Agent : Depuis quel navigateur ? → pas encore de réponse du client");
    expect(render.text).toContain("• Procédure syn-login : échec");
    expect(render.text).toContain("*Pourquoi l'équipe :* le client demande à parler à une personne");
    expect(render.text).not.toMatch(/https?:\/\/app\.example|Soleil2024|06 12 34|token=/);
    expect(render.text).toMatch(/_Réf\. HO-[0-9a-f]{12}_$/);
    expect(scrubHandoffNoticeText(render.text)).toBe(render.text);
    // A notice sealed before the synthesis existed only knows how many questions were asked.
    const { summary: _unused, ...sealed } = facts;
    expect(renderHandoffNotice(sealed, { contact: { status: "unverified", why: "no_matching_contact" }, ticket: { status: "verified", id: "9500001" } }, "1234567").text).toContain("*Échanges :*\n• Agent : 2 question(s) posée(s) au client");
    expect(sanitizeNoticeText("• x")).toBe("• x");
  });
});


it("associates each answer in a multi-question mail with its own fact keys in the handoff report", () => {
  const current = body({ facts: [
    { id: "f1", key: "browser", text: "Firefox", source: email("partial"), at: AT(5), kind: "customer_statement" },
    { id: "f2", key: "device", text: "Ordinateur", source: email("partial"), at: AT(5), kind: "customer_statement" },
  ], questions: [
    { id: "q1", text: "Quel navigateur ?", factKeys: ["browser"], askedAt: AT(2), askedInEffect: "batch", answeredBy: email("partial") },
    { id: "q2", text: "Quel appareil ?", factKeys: ["device"], askedAt: AT(2), askedInEffect: "batch", answeredBy: email("partial") },
    { id: "q3", text: "Quelle version ?", factKeys: ["version"], askedAt: AT(2), askedInEffect: "batch" },
  ] });
  expect(buildCaseHandoffSummary(current).exchanges).toEqual([
    { question: "Quel navigateur ?", answered: true, answer: "Firefox", customerWroteAfter: true },
    { question: "Quel appareil ?", answered: true, answer: "Ordinateur", customerWroteAfter: true },
    { question: "Quelle version ?", answered: false, answer: null, customerWroteAfter: true },
  ]);
});


it("retains both parts of a question answered across successive customer mails", () => {
  const current = body({ facts: [
    { id: "f1", key: "browser", text: "Firefox", source: email("partial-1"), at: AT(5), kind: "customer_statement" },
    { id: "f2", key: "device", text: "Ordinateur", source: email("partial-2"), at: AT(6), kind: "customer_statement" },
  ], questions: [
    { id: "q1", text: "Quel navigateur et appareil ?", factKeys: ["browser", "device"], askedAt: AT(2), askedInEffect: "batch", answeredBy: email("partial-2") },
    { id: "q2", text: "Quelle version ?", factKeys: ["version"], askedAt: AT(2), askedInEffect: "batch" },
  ] });
  expect(buildCaseHandoffSummary(current).exchanges[0]).toEqual({ question: "Quel navigateur et appareil ?", answered: true, answer: "Firefox ; Ordinateur", customerWroteAfter: true });
});
