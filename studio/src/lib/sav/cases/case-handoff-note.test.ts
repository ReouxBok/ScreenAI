import { describe, expect, it, vi } from "vitest";
vi.mock("@/db", () => ({ requireDb: () => { throw Error("NO_DB_ALLOWED"); } }));
import { emptyCaseBody, type CaseBody } from "./case-types";
import { customerLinkOf, customerLinksOf, CASE_HANDOFF_SUMMARY_LIMITS, type CaseHandoffReceived } from "./case-handoff-summary";
import { handoffNoteText, handoffNoticeFacts, type HandoffReason } from "./case-handoff-notice";
import { handoffNoteOf } from "./case-handoff-notice-store";

/* SAV-92 (Ugo 16/11): the HubSpot handoff note as a short narrative, and the customer's full links. SYN data only. */
const AT = (m: number) => `2026-11-16T08:${String(m).padStart(2, "0")}:00.000Z`;
const email = (id: string) => ({ type: "email" as const, id });
const CASE_ID = "10000000-0000-4000-8000-000000000016", TICKET = "9500016", INPUT = "in:gm-syn-2";
const subject = { status: "available" as const, text: "Connexion impossible à la plateforme.", provenance: { source: "v1_accepted_analysis" as const, field: "ticketSummary" as const,
  runId: "30000000-0000-4000-8000-000000000016", runVersion: 1, resultHash: "h", validatorRevision: "v", acceptedAt: AT(0) } };
const request = { id: "r1", summary: "Demande support", family: "access", status: "open", openedAt: AT(0), subject };
const trial = (id: string, knowledgeId: string, outcome: "failed" | "pending" | "succeeded" | "unknown", m: number) => ({
  id, requestId: "r1", procedure: { knowledgeId, contentVersionId: `${knowledgeId}-v3` }, askedAt: AT(m), outcome,
  resultAt: outcome === "pending" ? null : AT(m + 1), ...(outcome === "failed" ? { result: { text: "Toujours bloqué.", source: email("gm-syn-2") } } : {}) });
const body = (over: Partial<CaseBody> = {}) => ({ ...emptyCaseBody(), openRequests: [request], ...over }) as CaseBody;
function note(reason: HandoffReason, caseBody: CaseBody, received?: CaseHandoffReceived) {
  const trigger = { ok: true as const, caseId: CASE_ID, ticketId: TICKET, inputKey: INPUT, recordedAtVersion: 4, reason,
    report: { need: "Le client ne peut plus se connecter.", expected: null, observed: null, trialIds: caseBody.trials.map(row => row.id), hypotheses: [], missingInformation: [],
      expectedIntervention: "Vérifier le compte (modèle syn-model-1)." } };
  const facts = handoffNoticeFacts(trigger, caseBody, received);
  return { facts, text: handoffNoteText({ ...facts, summary: facts.summary! }) };
}
const withTrials = (outcome: "failed" | "pending") => body({
  facts: [
    { id: "f1", text: "Je n'arrive plus à me connecter à mon espace.", source: email("gm-syn-1"), at: AT(1), key: null, kind: "customer_statement" },
    { id: "f2", text: "Le message affiché est « accès refusé ».", source: email("gm-syn-2"), at: AT(5), key: null, kind: "customer_statement" },
  ],
  questions: [{ id: "q1", text: "Quel message s'affiche ?", factKeys: [], askedAt: AT(2), askedInEffect: "e1", answeredBy: email("gm-syn-2") }],
  trials: [trial("t1", "syn-access-reset", "failed", 3), trial("t2", "syn-access-magic-link", outcome, 6)],
});
const MAIL_LINKS = customerLinksOf(["Voici la conversation : https://app.example.invalid/conversation/c-77?token=abc123&lang=fr."]);

describe("HubSpot handoff note: a short narrative (exact texts)", () => {
  it("simple case: V1's subject, nothing asked, tried or sent", () => {
    expect(note("knowledge_missing", body()).text).toBe([
      "Le client signale : connexion impossible à la plateforme.",
      "Je n'ai pas de solution adaptée à cette demande.",
      "Je passe le dossier à l'équipe."].join("\n"));
  });

  it("with trials and a link: neutral labels, the outcome of the last trial, the full cleaned link, the files", () => {
    const received: CaseHandoffReceived = { files: [{ name: "capture.png", type: "image/png", sizeKb: 120 }], omitted: 0, links: MAIL_LINKS };
    expect(note("repeated_failure", withTrials("failed"), received).text).toBe([
      "Le client écrit : « Je n'arrive plus à me connecter à mon espace. »",
      "Nous lui avons posé une question ; il nous a répondu.",
      "Nous avons essayé une première solution puis une autre solution ; le problème persiste.",
      "Il nous a envoyé ce lien : https://app.example.invalid/conversation/c-77?lang=fr",
      "Il a joint un fichier à ses messages.",
      "Les solutions proposées n'ont pas suffi.",
      "Je passe le dossier à l'équipe."].join("\n"));
  });

  it("without a link: no link sentence; a pending last trial says we wait", () => {
    expect(note("explicit_human_request", withTrials("pending")).text).toBe([
      "Le client écrit : « Je n'arrive plus à me connecter à mon espace. »",
      "Nous lui avons posé une question ; il nous a répondu.",
      "Nous avons essayé une première solution puis une autre solution ; nous attendons son retour.",
      "Le client souhaite échanger avec une personne.",
      "Je passe le dossier à l'équipe."].join("\n"));
  });

  it("sensitive case, unknown sheet identifiers, three trials, unanswered question: generic labels only", () => {
    const sensitive = body({
      questions: [{ id: "q1", text: "Pouvez-vous préciser ?", factKeys: [], askedAt: AT(2), askedInEffect: "e1" }, { id: "q2", text: "Et ensuite ?", factKeys: [], askedAt: AT(4), askedInEffect: "e2" }],
      trials: [trial("t1", "fiche interne/accès #12", "failed", 3), trial("t2", "syn-unknown", "failed", 5), trial("t3", "syn-other", "unknown", 7)],
    });
    expect(note("sensitive_request", sensitive).text).toBe([
      "Le client signale : connexion impossible à la plateforme.",
      "Nous lui avons posé 2 questions ; nous attendons encore sa réponse.",
      "Nous avons essayé une première solution puis 2 autres solutions ; nous ne savons pas encore si cela a suffi.",
      "La demande est sensible et relève de l'équipe.",
      "Je passe le dossier à l'équipe."].join("\n"));
  });

  it("a team part names the part to take back and passes only that part", () => {
    const { facts } = note("outside_active_blocks", body());
    const text = handoffNoteText({ ...facts, summary: facts.summary!, need: "Partie du message à reprendre par l'équipe (1 demande) : « changer l'adresse de facturation »" });
    expect(text.split("\n").slice(1)).toEqual([
      "La partie à reprendre : « changer l'adresse de facturation »",
      "Cette partie de la demande relève de l'équipe ; je continue de traiter le reste du message.",
      "Je passe cette partie de la demande à l'équipe."]);
  });

  it("no identifier, sheet name, model name, reply text or technical term ever leaks", () => {
    const received: CaseHandoffReceived = { files: [], omitted: 0, links: MAIL_LINKS };
    const leaks = [CASE_ID, TICKET, INPUT, "gm-syn", "syn-access", "-v3", "syn-model", "fiche", "modèle", "validateur", "bloc", "V2", "agent", "HO-", "handoff", "token", "abc123",
      "Toujours bloqué", "Vérifier le compte", "Quel message", "Demande support"];
    for (const reason of ["knowledge_missing", "knowledge_conflict", "decision_refused", "repeated_failure", "evidence_inaccessible", "diagnosis_out_of_tools", "team_part_handoff_unavailable"] as const) {
      const { text, facts } = note(reason, withTrials("failed"), received);
      for (const leak of leaks) expect({ reason, leak, found: text.includes(leak) }).toEqual({ reason, leak, found: false });
      expect(text).not.toContain(handoffNoteOf(facts, AT(9))!.interactionId);
    }
  });

  it("one note per handoff: same interaction id and same text on every call (same business keys, same marker); none without a synthesis", () => {
    const { facts } = note("repeated_failure", withTrials("failed"));
    const first = handoffNoteOf(facts, AT(9)), again = handoffNoteOf(facts, AT(9));
    expect(first).toEqual(again);
    expect(first!.interactionId).toMatch(/^handoff:[0-9a-f]{32}$/);
    expect(first!.text).toBe(handoffNoteText({ ...facts, summary: facts.summary! }));
    const { summary: _none, ...sealedBefore } = facts;
    expect(handoffNoteOf(sealedBefore, AT(9))).toBeUndefined();
  });
});

describe("customer links: full https links, cleaned and bounded", () => {
  it("keeps a clean https link whole, trailing punctuation dropped", () => {
    expect(customerLinkOf("https://app.example.invalid/conversation/c-77?lang=fr#message-4).")).toBe("https://app.example.invalid/conversation/c-77?lang=fr#message-4");
  });
  it("removes the sensitive parameters and a fragment carrying a value", () => {
    expect(customerLinkOf("https://app.example.invalid/c/1?token=abc&page=2&api_key=k&code=99&password=p&auth=a&sessionId=s&email=x%40y.invalid"))
      .toBe("https://app.example.invalid/c/1?page=2");
    expect(customerLinkOf("https://app.example.invalid/callback#access_token=abc&state=1")).toBe("https://app.example.invalid/callback");
  });
  it("rejects http, credentials, ports, addresses, token-shaped paths and over-long links", () => {
    expect(customerLinkOf("http://app.example.invalid/conversation/1")).toBeNull();
    expect(customerLinkOf("https://user:pass@app.example.invalid/conversation/1")).toBeNull();
    expect(customerLinkOf("https://user@app.example.invalid/conversation/1")).toBeNull();
    expect(customerLinkOf("https://app.example.invalid:8443/x")).toBeNull();
    expect(customerLinkOf("https://192.168.0.1/x")).toBeNull();
    expect(customerLinkOf("https://localhost/x")).toBeNull();
    expect(customerLinkOf("https://app.example.invalid/reset/eyJhbGciOiJIUzI1NiJ9.e30.sig")).toBeNull();
    expect(customerLinkOf(`https://app.example.invalid/reset/${"a1".repeat(20)}`)).toBeNull();
    expect(customerLinkOf(`https://app.example.invalid/${"page/".repeat(70)}`)).toBeNull();
  });
  it("at most five distinct links, http and credentials skipped, idempotent", () => {
    const text = ["http://plain.example.invalid/a", "https://u:p@creds.example.invalid/a",
      ...Array.from({ length: 7 }, (_, i) => `https://app.example.invalid/c/${i}?token=t${i}`), "https://app.example.invalid/c/0"].join(" et ");
    const links = customerLinksOf([text]);
    expect(links).toEqual([0, 1, 2, 3, 4].map(i => `https://app.example.invalid/c/${i}`));
    expect(links).toHaveLength(CASE_HANDOFF_SUMMARY_LIMITS.links);
    expect(customerLinksOf(links)).toEqual(links);
  });
});
