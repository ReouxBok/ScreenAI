import { describe, expect, it, vi } from "vitest";
vi.mock("@/db", () => ({ requireDb: () => { throw Error("NO_DB_ALLOWED"); } }));
import { emptyCaseBody, type CaseBody } from "./case-types";
import { customerLinkOf, customerLinkScan, customerLinksOf, CASE_HANDOFF_SUMMARY_LIMITS, type CaseHandoffReceived } from "./case-handoff-summary";
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
const MAIL_TEXTS = ["Voici la conversation : https://app.limova.ai/conversation/c-77?utm_source=abc123&lang=fr."];

describe("HubSpot handoff note: a short narrative (exact texts)", () => {
  it("simple case: V1's subject, nothing asked, tried or sent", () => {
    expect(note("knowledge_missing", body()).text).toBe([
      "Le client signale : connexion impossible à la plateforme.",
      "Je n'ai pas de solution adaptée à cette demande.",
      "Je passe le dossier à l'équipe."].join("\n"));
  });

  it("with trials and a link: neutral labels, the outcome of the last trial, the full cleaned link, the files", () => {
    const received: CaseHandoffReceived = { files: [{ name: "capture.png", type: "image/png", sizeKb: 120 }], omitted: 0, linkTexts: MAIL_TEXTS };
    expect(note("repeated_failure", withTrials("failed"), received).text).toBe([
      "Le client écrit : « Je n'arrive plus à me connecter à mon espace. »",
      "Nous lui avons posé une question ; il nous a répondu.",
      "Nous avons essayé une première solution puis une autre solution ; le problème persiste.",
      "Il nous a envoyé ce lien : https://app.limova.ai/conversation/c-77?lang=fr",
      "Il a joint un fichier à ses messages.",
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
    const received: CaseHandoffReceived = { files: [], omitted: 0, linkTexts: MAIL_TEXTS };
    const leaks = [CASE_ID, TICKET, INPUT, "gm-syn", "syn-access", "-v3", "syn-model", "fiche", "modèle", "validateur", "bloc", "V2", "agent", "HO-", "handoff", "token", "abc123", "utm_source",
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

describe("customer links: conservative policy (review Astra of 1289893)", () => {
  const SECRET = "R7mQ2vX9pL4nW8zK";
  it("Astra's regressions: an authentication link is rejected whole, and the note only says a link was masked", () => {
    const astra = [`https://app.limova.ai/reset?reset=${SECRET}`, `https://app.limova.ai/login?magic=${SECRET}`,
      `https://app.limova.ai/reset/${SECRET}`, `https://app.limova.ai/login#${SECRET}`];
    for (const link of astra) expect({ link, kept: customerLinkOf(link) }).toEqual({ link, kept: null });
    expect(customerLinkScan([astra.join(" et ")])).toEqual({ links: [], masked: 4 });
    const { text } = note("knowledge_missing", body(), { files: [], omitted: 0, linkTexts: [`Voici le lien : ${astra[0]}`] });
    expect(text).toBe(["Le client signale : connexion impossible à la plateforme.", "Il nous a envoyé un lien (masqué par sécurité, voir le mail).",
      "Je n'ai pas de solution adaptée à cette demande.", "Je passe le dossier à l'équipe."].join("\n"));
    expect(text).not.toContain(SECRET);
  });
  it("a legitimate conversation link is kept (fragment always removed); a UUID only right after conversation/chat/thread/share", () => {
    expect(customerLinkOf("https://app.limova.ai/conversation/c-77?lang=fr#message-4).")).toBe("https://app.limova.ai/conversation/c-77?lang=fr");
    const uuid = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    expect(customerLinkOf(`https://app.limova.ai/chat/${uuid}`)).toBe(`https://app.limova.ai/chat/${uuid}`);
    expect(customerLinkOf(`https://app.limova.ai/files/${uuid}`)).toBeNull();
    expect(customerLinkOf(`https://app.limova.ai/sso/conversation/${uuid}`)).toBeNull();
  });
  it("parameters: only lang, page, tab and a short numeric id with a plain value; a secret-looking value is removed", () => {
    expect(customerLinkOf("https://app.limova.ai/c/1?page=2&ref=abc&id=42&key=k&code=99&email=x%40y.invalid&utm_source=mail")).toBe("https://app.limova.ai/c/1?page=2&id=42");
    expect(customerLinkOf(`https://app.limova.ai/c/1?tab=${SECRET}&id=${SECRET}&lang=fr`)).toBe("https://app.limova.ai/c/1?lang=fr");
    expect(customerLinkOf("https://app.limova.ai/c/1?id=12345678901234")).toBe("https://app.limova.ai/c/1");
  });
  it("rejects authentication words anywhere, token-shaped segments, http, credentials, ports, addresses and over-long links", () => {
    for (const link of ["https://app.limova.ai/signin", "https://app.limova.ai/account/verify-email", "https://app.limova.ai/x?invite=1",
      "https://app.limova.ai/x#otp", "https://app.limova.ai/oauth2/cb", "https://app.limova.ai/unlock", "https://app.limova.ai/activate/1",
      `https://app.limova.ai/doc/${SECRET}`, "https://app.limova.ai/doc/eyJhbGciOiJIUzI1NiJ9.e30.sig", `https://app.limova.ai/doc/${"a1".repeat(20)}`,
      "http://app.limova.ai/conversation/1", "https://user:pass@app.limova.ai/conversation/1", "https://user@app.limova.ai/conversation/1",
      "https://app.limova.ai:8443/x", "https://192.168.0.1/x", "https://localhost/x", `https://app.limova.ai/${"page/".repeat(70)}`])
      expect({ link, kept: customerLinkOf(link) }).toEqual({ link, kept: null });
  });
  it("strict allow-list (review Astra of 54694e4): only limova.ai and its subdomains; every other link is masked", () => {
    const others = ["https://auth.example.invalid/s/A7b8C9d0E1f2", "https://share.example.invalid/f/Ab3Cd4Ef5Gh6", "https://share.example.invalid/f/Ab3Cd4Ef5Gh6Ij7",
      "https://shop.example.invalid/pay/x7Kq2", "https://bit.ly/Ab3Cd4E", "https://limova.ai.example.invalid/conversation/c-1", "https://evillimova.ai/conversation/c-1"];
    for (const link of others) expect({ link, kept: customerLinkOf(link) }).toEqual({ link, kept: null });
    expect(customerLinkScan([others.join(" ")])).toEqual({ links: [], masked: others.length });
    expect(customerLinkOf("https://app.limova.ai/conversation/c-77")).toBe("https://app.limova.ai/conversation/c-77");
    expect(customerLinkOf("https://limova.ai/conversation/c-77")).toBe("https://limova.ai/conversation/c-77");
    const { text } = note("knowledge_missing", body(), { files: [], omitted: 0, linkTexts: ["Lien : https://bit.ly/Ab3Cd4E et https://app.limova.ai/conversation/c-77"] });
    expect(text.split("\n").slice(1, 3)).toEqual(["Il nous a envoyé ce lien : https://app.limova.ai/conversation/c-77",
      "Il nous a aussi envoyé un lien (masqué par sécurité, voir le mail)."]);
  });

  it("inherited property names never break the synthesis (constructor, __proto__); a link that cannot be judged is masked and the note is still written", () => {
    expect(customerLinkOf("https://app.limova.ai/conversation/c-77?constructor=x&__proto__=x&toString=y&lang=fr")).toBe("https://app.limova.ai/conversation/c-77?lang=fr");
    expect(customerLinkOf("https://app.limova.ai/conversation/%E0%A4%A")).toBeNull();
    const { facts, text } = note("knowledge_missing", body(), { files: [], omitted: 0,
      linkTexts: ["https://app.limova.ai/c/1?constructor=x https://app.limova.ai/c/2?__proto__=x https://app.limova.ai/conversation/%E0%A4%A"] });
    expect(facts.summary).toBeDefined();
    expect(handoffNoteOf(facts, AT(9))?.text).toBe(text);
    expect(text).toContain("Il nous a envoyé ces liens : https://app.limova.ai/c/1 ; https://app.limova.ai/c/2");
    expect(text).toContain("Il nous a aussi envoyé un lien (masqué par sécurité, voir le mail).");
  });

  it("at most five distinct links, rejected ones counted as masked, idempotent", () => {
    const text = ["http://plain.example.invalid/a", "https://u:p@creds.example.invalid/a",
      ...Array.from({ length: 7 }, (_, i) => `https://app.limova.ai/c/${i}?ref=t${i}`), "https://app.limova.ai/c/0"].join(" et ");
    const scan = customerLinkScan([text]);
    expect(scan).toEqual({ links: [0, 1, 2, 3, 4].map(i => `https://app.limova.ai/c/${i}`), masked: 2 });
    expect(scan.links).toHaveLength(CASE_HANDOFF_SUMMARY_LIMITS.links);
    expect(customerLinksOf(scan.links)).toEqual(scan.links);
  });
});
