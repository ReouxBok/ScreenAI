import { describe, expect, it } from "vitest";
import { emptyCaseBody, type CaseBody } from "./case-types";
import { buildCaseHandoffSummary, caseHandoffSummaryLines, CASE_HANDOFF_SUMMARY_LIMITS } from "./case-handoff-summary";
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
      { question: "Quel message s'affiche à l'écran ?", answered: true, answer: expect.stringContaining("compte verrouillé") },
      { question: "Depuis quel navigateur ?", answered: false, answer: null },
    ]);
    expect(summary.exchanges[0]!.answer).not.toContain("token=xyz");
    expect(summary.transmitted).toEqual({ attachments: 1, links: 1, linkHosts: ["app.example.invalid"] });
    expect(summary.tried).toEqual([{ knowledgeId: "syn-login", outcome: "failed", result: "Toujours verrouillé après réinitialisation." }]);
    const lines = caseHandoffSummaryLines(summary, "le client demande à parler à une personne");
    expect(lines).toContain("• Réponse : aucune pour l'instant");
    expect(lines).toContain("• Éléments transmis : 1 pièce(s) jointe(s) ou capture(s) d'écran, 1 lien(s) (app.example.invalid)");
    expect(lines.at(-1)).toBe("• Raison du transfert : le client demande à parler à une personne");
  });

  it("without customer words: V1's subject; without anything: says so; nothing transmitted and nothing tried are stated", () => {
    expect(buildCaseHandoffSummary(body({ facts: [] })).problem).toEqual({ source: "v1_subject", text: "Connexion impossible à la plateforme." });
    const bare = buildCaseHandoffSummary({ ...emptyCaseBody() });
    expect(bare.problem).toEqual({ source: "none", text: null });
    expect(caseHandoffSummaryLines(bare, "x")).toEqual([
      "• Problème : non relevé dans le dossier", "• Questions de l'agent : aucune",
      "• Éléments transmis : aucune capture d'écran ni pièce jointe, aucun lien", "• Essais : aucun", "• Raison du transfert : x"]);
  });

  it("bounded: long texts are cut, older questions and trials counted, the whole capped", () => {
    const long = "mot ".repeat(1000);
    const many = body({
      facts: [{ id: "f1", text: long, source: email("gm-1"), at: AT(1), key: null, kind: "customer_statement" }],
      questions: Array.from({ length: 9 }, (_, i) => ({ id: `q${i}`, text: long, factKeys: [], askedAt: AT(10 + i), askedInEffect: `e${i}`, answeredBy: email("gm-1") })),
      trials: Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, requestId: "r1", procedure: { knowledgeId: `k${i}`, contentVersionId: "v" }, askedAt: AT(i), outcome: "pending" as const, resultAt: null })),
    });
    const summary = buildCaseHandoffSummary(many);
    expect(summary.problem.text!.length).toBeLessThanOrEqual(CASE_HANDOFF_SUMMARY_LIMITS.problemChars);
    expect(summary.exchanges).toHaveLength(CASE_HANDOFF_SUMMARY_LIMITS.questions);
    expect(summary.exchangesOmitted).toBe(4);
    expect(summary.triedOmitted).toBe(3);
    const lines = caseHandoffSummaryLines(summary, "x");
    expect(lines.join("\n").length).toBeLessThanOrEqual(CASE_HANDOFF_SUMMARY_LIMITS.totalChars + 30);
    expect(lines.at(-2)).toBe("• (synthèse coupée)");
    expect(lines.at(-1)).toBe("• Raison du transfert : x");
  });

  it("the Slack notice keeps its template, adds the synthesis after it (channel-cleaned), keeps the marker, and re-scrubbing changes nothing", () => {
    const trigger = { ok: true as const, caseId: "10000000-0000-4000-8000-000000000001", ticketId: "9500001", inputKey: "in:gm-2", recordedAtVersion: 4, reason: "explicit_human_request" as const,
      report: { need: "Le client ne peut plus se connecter.", expected: null, observed: null, trialIds: ["t1"], hypotheses: [], missingInformation: [], expectedIntervention: "Rappeler le client." } };
    const facts = handoffNoticeFacts(trigger, body());
    const render = renderHandoffNotice(facts, { contact: { status: "unverified", why: "no_matching_contact" }, ticket: { status: "verified", id: "9500001" } }, "1234567");
    const lines = render.text.split("\n");
    expect(lines.indexOf("*Synthèse du dossier :*")).toBeGreaterThan(lines.findIndex(line => line.startsWith("*Prochaine action proposée :*")));
    expect(render.text).toContain("• Question : Quel message s'affiche à l'écran ?");
    expect(render.text).toContain("• Raison du transfert : le client demande à parler à une personne");
    const synthesis = render.text.slice(render.text.indexOf("*Synthèse du dossier :*"));
    expect(synthesis).not.toMatch(/https?:|Soleil2024|06 12 34|token=/);
    expect(synthesis).toContain("• Éléments transmis : 1 pièce(s) jointe(s) ou capture(s) d'écran, 1 lien(s) (app.example.invalid)");
    expect(render.text).toMatch(/_Réf\. HO-[0-9a-f]{12}_$/);
    expect(scrubHandoffNoticeText(render.text)).toBe(render.text);
    // A notice sealed before the synthesis existed renders exactly as before.
    const { summary: _unused, ...sealed } = facts;
    expect(renderHandoffNotice(sealed, { contact: { status: "unverified", why: "no_matching_contact" }, ticket: { status: "verified", id: "9500001" } }, "1234567").text).not.toContain("Synthèse du dossier");
    expect(sanitizeNoticeText("• x")).toBe("• x");
  });
});
