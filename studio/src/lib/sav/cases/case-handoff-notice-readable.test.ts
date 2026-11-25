import { describe, expect, it } from "vitest";
import { emptyCaseBody, type CaseBody } from "./case-types";
import { buildCaseHandoffSummary } from "./case-handoff-summary";
import { handoffNoteText, handoffNoticeFacts, handoffNoticeKey, handoffNoticeMarker, renderHandoffNotice, scrubHandoffNoticeText, type HandoffNoticeTrigger } from "./case-handoff-notice";

/*
 * Ugo (25/11): the Slack hand-over notice must read in a few seconds. Fictional data only (`exemple.invalid`), shaped like the anonymised notice Ugo sent:
 * a question asked twice (the automatic reminder), the customer replying afterwards, the same signature image in every mail, and the Smart note's
 * « Vérifié » / « Essayé » rows stored among the report's hypotheses.
 */
const CASE = "50000000-0000-4000-8000-000000000001", TICKET = "9002", PORTAL = "1234567", INPUT = "in:gm-syn-3";
const AT = (h: number, m = 0) => `2026-11-25T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
const email = (id: string) => ({ type: "email" as const, id });
const VERIFIED = { contact: { status: "verified", id: "777", name: "Camille Fictive" }, ticket: { status: "verified", id: TICKET } } as const;

const FORMAT = "Quel est le format et le poids du visuel que vous essayez d'insérer ?";
const CAPTURE = "Pouvez-vous aussi m'envoyer une capture de l'écran du brouillon ?";
function caseBody(over: Partial<CaseBody> = {}): CaseBody {
  return { ...emptyCaseBody(),
    openRequests: [
      { id: "gm-syn-1/r0", summary: "Demande support", family: "usage", status: "open", openedAt: AT(8) },
      // The customer's reply after the reminder: a new mail of the case, nothing matched to the question.
      { id: "gm-syn-3/message", summary: "Réponse du client", family: "usage", status: "open", openedAt: AT(11) },
    ],
    questions: [
      { id: "q1", text: FORMAT, factKeys: [], askedAt: AT(9), askedInEffect: "e1" },
      { id: "q2", text: `${FORMAT} `, factKeys: [], askedAt: AT(10), askedInEffect: "e2" },
      { id: "q3", text: CAPTURE, factKeys: [], askedAt: AT(10), askedInEffect: "e2" },
    ],
    ...over } as CaseBody;
}
const received = { files: [
  { name: "image001.png", type: "image/png", sizeKb: 4 }, { name: "bandeau-fictif.png", type: "image/png", sizeKb: 88 },
  { name: "image001.png", type: "image/png", sizeKb: 4 }, { name: "image001.png", type: "image/png", sizeKb: 4 },
], omitted: 0 };
const trigger = (hypotheses: string[]): Extract<HandoffNoticeTrigger, { ok: true }> => ({
  ok: true, caseId: CASE, ticketId: TICKET, inputKey: INPUT, recordedAtVersion: 7, reason: "diagnosis_out_of_tools",
  report: { need: "Insérer un visuel dans un brouillon généré par Charly", expected: null, observed: "Charly génère le brouillon sans inclure l'image", trialIds: [], hypotheses,
    missingInformation: [], expectedIntervention: "Vérifier l'insertion d'images dans les brouillons et répondre au client." },
});
const SMART_ROWS = [
  "L'intégration de messagerie ne gère pas l'insertion d'images (ouverte)",
  "Vérifié : L'URL de la conversation et les détails du fichier (source : mailclient)",
  "Essayé : Création de brouillon via Charly avec intégration d'image → Brouillon créé mais sans le visuel",
];

describe("the hand-over notice reads at a glance (Ugo 25/11)", () => {
  it("renders the fictional version of Ugo's case in the short layout, with no repeated synthesis block", () => {
    const facts = handoffNoticeFacts(trigger(SMART_ROWS), caseBody(), received);
    const text = renderHandoffNotice(facts, VERIFIED, PORTAL).text;
    expect(text).toBe([
      "*Nouveau ticket à transmettre à l'équipe*",
      `*Client :* Camille Fictive — <https://app.hubspot.com/contacts/${PORTAL}/record/0-1/777|fiche contact HubSpot>`,
      "*Demande :* Insérer un visuel dans un brouillon généré par Charly",
      ["*Échanges :*",
        `• Agent : ${FORMAT} → le client a répondu (voir son dernier mail)`,
        `• Agent : ${CAPTURE} → le client a répondu (voir son dernier mail)`,
        "• Pièces jointes du client : image001.png (image/png, 4 Ko) ; bandeau-fictif.png (image/png, 88 Ko)"].join("\n"),
      ["*Ce que l'agent a établi :* (3 premiers éléments sur 4)",
        "• Vérifié : L'URL de la conversation et les détails du fichier (source : mailclient)",
        "• Essayé : Création de brouillon via Charly avec intégration d'image → Brouillon créé mais sans le visuel",
        "• Constaté : Charly génère le brouillon sans inclure l'image"].join("\n"),
      "*Pourquoi l'équipe :* le diagnostic dépasse les outils de l'agent",
      "*À faire :* Vérifier l'insertion d'images dans les brouillons et répondre au client.",
      `*Ticket HubSpot :* <https://app.hubspot.com/contacts/${PORTAL}/record/0-5/${TICKET}|ticket ${TICKET}>`,
      `_Réf. ${handoffNoticeMarker(handoffNoticeKey(CASE, INPUT))}_`,
    ].join("\n\n"));
    expect(text).not.toMatch(/Hypothèse : (?:Vérifié|Essayé)|Synthèse du dossier|Essais : aucun|aucune pour l'instant/);
    expect(scrubHandoffNoticeText(text)).toBe(text);
  });

  it("Ugo (25/11, « absolument » aéré): one blank line between every section, the bullets of a section stay together", () => {
    const text = renderHandoffNotice(handoffNoticeFacts(trigger(SMART_ROWS), caseBody(), received), VERIFIED, PORTAL).text;
    const headings = ["*Client :*", "*Demande :*", "*Échanges :*", "*Ce que l'agent a établi :*", "*Pourquoi l'équipe :*", "*À faire :*", "*Ticket HubSpot :*"];
    const sections = text.split("\n\n");
    expect(sections.map(section => headings.find(heading => section.startsWith(heading)) ?? section.slice(0, 6))).toEqual(["*Nouve", ...headings, "_Réf. "]);
    // Each heading is preceded by an empty line; inside a section no line is empty and every line after the heading is a bullet.
    for (const heading of headings) expect(text).toContain(`\n\n${heading}`);
    for (const section of sections) {
      expect(section.split("\n").every(line => line.trim() !== "")).toBe(true);
      expect(section.split("\n").slice(1).every(line => line.startsWith("• "))).toBe(true);
    }
    expect(text).not.toMatch(/\n{3}/);
  });

  it("a question asked twice (the reminder) is listed once", () => {
    const text = renderHandoffNotice(handoffNoticeFacts(trigger([]), caseBody(), received), VERIFIED, PORTAL).text;
    expect(text.split(FORMAT)).toHaveLength(2);
    expect(buildCaseHandoffSummary(caseBody()).exchanges.map(row => row.question)).toEqual([FORMAT, CAPTURE]);
  });

  it("each line of the Smart note keeps its own label: Vérifié, Essayé, Hypothèse", () => {
    const text = renderHandoffNotice(handoffNoticeFacts({ ...trigger(SMART_ROWS), report: { ...trigger(SMART_ROWS).report, observed: null } }, caseBody(), received), VERIFIED, PORTAL).text;
    expect(text).toContain([
      "*Ce que l'agent a établi :*",
      "• Vérifié : L'URL de la conversation et les détails du fichier (source : mailclient)",
      "• Essayé : Création de brouillon via Charly avec intégration d'image → Brouillon créé mais sans le visuel",
      "• Hypothèse : L'intégration de messagerie ne gère pas l'insertion d'images (ouverte)",
    ].join("\n"));
    // One list: never « Essais : aucun » next to an « Essayé » line.
    expect(text).not.toMatch(/Essais : aucun|Aucun essai/);
  });

  it("the same attachment in several mails (same name, same size) is listed once; another size is another file", () => {
    const text = renderHandoffNotice(handoffNoticeFacts(trigger([]), caseBody(), { ...received, files: [...received.files, { name: "image001.png", type: "image/png", sizeKb: 31 }] }), VERIFIED, PORTAL).text;
    expect(text).toContain("• Pièces jointes du client : image001.png (image/png, 4 Ko) ; bandeau-fictif.png (image/png, 88 Ko) ; image001.png (image/png, 31 Ko)");
  });

  it("the customer's reply: « a répondu » only when a customer mail is dated after the question; otherwise « pas encore de réponse »", () => {
    const after = renderHandoffNotice(handoffNoticeFacts(trigger([]), caseBody(), received), VERIFIED, PORTAL).text;
    expect(after).toContain(`• Agent : ${CAPTURE} → le client a répondu (voir son dernier mail)`);
    // The customer's last mail is the one that opened the case, before every question: nothing is invented.
    const before = renderHandoffNotice(handoffNoticeFacts(trigger([]), caseBody({ openRequests: caseBody().openRequests.slice(0, 1) }), received), VERIFIED, PORTAL).text;
    expect(before).toContain(`• Agent : ${FORMAT} → pas encore de réponse du client`);
    expect(before).toContain(`• Agent : ${CAPTURE} → pas encore de réponse du client`);
    expect(before).not.toContain("a répondu");
    // An answer matched to the question is quoted (masked); the HubSpot note says the customer replied.
    const answered = caseBody({ facts: [{ id: "f1", text: "Un PNG de 2 Mo", source: email("gm-syn-3"), at: AT(11), key: null, kind: "customer_statement" }],
      questions: [{ id: "q1", text: FORMAT, factKeys: [], askedAt: AT(9), askedInEffect: "e1", answeredBy: email("gm-syn-3") }] });
    expect(renderHandoffNotice(handoffNoticeFacts(trigger([]), answered), VERIFIED, PORTAL).text).toContain(`• Agent : ${FORMAT} → réponse du client : Un PNG de 2 Mo`);
    expect(handoffNoteText({ reason: "diagnosis_out_of_tools", need: "x", summary: buildCaseHandoffSummary(caseBody()) })).toContain("il nous a répondu.");
  });

  it("a synthesis sealed before this rule (a reminder listed twice, no reply date) still reads once and claims no reply", () => {
    const facts = handoffNoticeFacts(trigger([]), caseBody(), received);
    const old = { ...facts, summary: { ...facts.summary!, exchanges: [
      { question: FORMAT, answer: null, answered: false }, { question: FORMAT, answer: null, answered: false }] } };
    const text = renderHandoffNotice(old, VERIFIED, PORTAL).text;
    expect(text.split(FORMAT)).toHaveLength(2);
    expect(text).toContain(`• Agent : ${FORMAT} → aucune réponse relevée dans le dossier`);
  });
});
