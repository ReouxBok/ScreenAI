import { afterEach, describe, expect, it, vi } from "vitest";
import { observeSavOther, readSavOtherConfiguration, savOtherFamilies, savOtherSubjectHash, type SavOtherFamily, type SavOtherRegistry } from "./other-observation";

const mailboxId = "10000000-0000-4000-8000-000000000001";
const subjects: Record<SavOtherFamily, string> = {
  trustpilot_positive: "Fixture — nouvel avis 5 étoiles",
  vistaprint_promotions: "Fixture — promotion imprimerie Alpha",
  datarevolution_prospecting: "Fixture — campagne commerciale Beta",
  own_campaign_copy: "Fixture — campagne interne Gamma",
};
const registry: SavOtherRegistry = { version: 1, rules: Object.entries(subjects).map(([family, subject]) => ({ family: family as SavOtherFamily, mailboxId, subjectSha256: [savOtherSubjectHash(subject)] })) };
function message(family: SavOtherFamily = "trustpilot_positive") {
  return { mailboxId, fromEmail: savOtherFamilies[family].sender, subject: subjects[family], gmailMessageId: "synthetic-only", protectedContext: false,
    body: { text: "Notification synthétique sans demande client réelle.", headers: { "message-id": "<synthetic@example.invalid>", "content-type": "text/plain", "in-reply-to": "", references: "", "auto-submitted": "" }, attachments: [] as unknown[] } };
}
afterEach(() => vi.unstubAllEnvs());
describe("Autre private observation configuration", () => {
  it("reads only the private environment and returns no candidates without a valid registry", () => {
    vi.stubEnv("SAV_OTHER_OBSERVATION_RULES_JSON", "");
    expect(readSavOtherConfiguration()).toEqual({ status: "not_configured", registry: null });
    expect(observeSavOther(message(), null)).toBeNull();
    vi.stubEnv("SAV_OTHER_OBSERVATION_RULES_JSON", JSON.stringify(registry));
    expect(readSavOtherConfiguration()).toEqual({ status: "configured", registry });
  });
  it.each(["{", "null", "[]", " ", "x".repeat(350_001), JSON.stringify({ ...registry, version: 2 }), JSON.stringify({ version: 1, rules: [] }), JSON.stringify({ ...registry, enabled: true }), JSON.stringify({ version: 1, rules: [{ ...registry.rules[0], family: "other_domain" }] }), JSON.stringify({ version: 1, rules: [{ ...registry.rules[0], mailboxId: "not-a-uuid" }] }), JSON.stringify({ version: 1, rules: [{ ...registry.rules[0], subjectSha256: ["*"] }] }), JSON.stringify({ version: 1, rules: [registry.rules[0], registry.rules[0]] })])("rejects malformed, broadened or conflicting config %#", raw => {
    expect(readSavOtherConfiguration(raw)).toEqual({ status: "invalid", registry: null });
  });
  it("normalizes only line endings, never case/whitespace/keywords", () => {
    expect(savOtherSubjectHash("A\r\nB\rC")).toBe(savOtherSubjectHash("A\nB\nC"));
    expect(savOtherSubjectHash("A")).not.toBe(savOtherSubjectHash("a"));
    expect(savOtherSubjectHash("A ")).not.toBe(savOtherSubjectHash("A"));
  });
});
describe("Autre candidates grant no routing permission", () => {
  it.each(Object.keys(subjects) as SavOtherFamily[])("observes only the exact %s family without mutating the input", family => {
    const input = message(family), before = structuredClone(input);
    expect(observeSavOther(input, registry)).toEqual({ family, label: savOtherFamilies[family].label, ruleVersion: "sav-other-observation-v1" });
    expect(input).toEqual(before);
  });
  it.each([
    { mailboxId: "10000000-0000-4000-8000-000000000002" }, { fromEmail: "noreply@trustpilot.com" },
    { fromEmail: "noreply.notifications@trustpilot.com.example.invalid" }, { subject: "Fixture — nouvel avis 2 étoiles" },
    { subject: subjects.trustpilot_positive + " " }, { gmailMessageId: null }, { protectedContext: true }, { body: null },
  ])("keeps uncertain source, scope and intent in support %#", patch => {
    expect(observeSavOther({ ...message(), ...patch }, registry)).toBeNull();
  });
  it.each(["in-reply-to", "references", "content-type", "message-id"])("requires the stored %s evidence", name => {
    const input = message(); delete (input.body.headers as Record<string, string>)[name];
    expect(observeSavOther(input, registry)).toBeNull();
  });
  it.each(["in-reply-to", "references"])("rejects a populated %s", name => {
    const input = message(); (input.body.headers as Record<string, string>)[name] = "<parent@example.invalid>";
    expect(observeSavOther(input, registry)).toBeNull();
  });
  it("rejects malformed payloads and case collisions without failing the dashboard", () => {
    for (const body of [{ text: 42 }, { text: "fixture", headers: { references: 42 } }, { text: "fixture" }]) {
      expect(observeSavOther({ ...message(), body: body as never }, registry)).toBeNull();
    }
    const input = message(); (input.body.headers as Record<string, string>)["References"] = "<hidden@example.invalid>";
    expect(observeSavOther(input, registry)).toBeNull();
  });
  it.each(["multipart/report", "multipart/mixed", "message/rfc822", "message/delivery-status"])("rejects %s envelopes", contentType => {
    const input = message(); input.body.headers["content-type"] = contentType;
    expect(observeSavOther(input, registry)).toBeNull();
  });
  it("rejects an automatic reply, attachment or bounded/truncated body", () => {
    const reply = message(); reply.body.headers["auto-submitted"] = "AUTO-REPLIED";
    const attachment = message(); attachment.body.attachments.push({ filename: "synthetic.txt" });
    for (const input of [reply, attachment, { ...message(), body: { ...message().body, text: "x".repeat(100_000) } }]) expect(observeSavOther(input, registry)).toBeNull();
  });
  it.each(["Re: ", "FW: ", "Fwd: ", "TR: ", "Rép: "])("rejects reply/forward subjects even if configured (%s)", prefix => {
    const input = message(); input.subject = prefix + input.subject;
    const rule = { ...registry.rules[0], subjectSha256: [savOtherSubjectHash(input.subject)] };
    expect(observeSavOther(input, { version: 1, rules: [rule] })).toBeNull();
  });
  it.each(["----- Forwarded message -----", "De : client@example.invalid", "From: client@example.invalid", "> Question humaine", "Une personne a écrit :", "Someone wrote:", "Demande de remboursement", "Litige client", "Mot de passe oublié", "Intégration déconnectée", "Delivery failure"])("vetoes forwarded or sensitive content: %s", text => {
    expect(observeSavOther({ ...message(), body: { ...message().body, text } }, registry)).toBeNull();
  });
  it.each(["Fixture — avis 1 étoile", "Fixture — avis 15 étoiles", "Fixture — avis 5 étoilesfaux"])("never calls a configured non-five-star subject positive: %s", subject => {
    const rule = { ...registry.rules[0], subjectSha256: [savOtherSubjectHash(subject)] };
    expect(observeSavOther({ ...message(), subject }, { version: 1, rules: [rule] })).toBeNull();
  });
});
