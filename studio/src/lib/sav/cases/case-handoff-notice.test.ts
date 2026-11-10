import { describe, expect, it } from "vitest";
import {
  buildHandoffNoticeIntent, HANDOFF_NOTICE_TITLE, HANDOFF_REASONS, HANDOFF_REASON_LABELS, handoffNoticeFacts, handoffNoticeKey, handoffNoticeMarker, handoffNoticeMarkerIn,
  judgeHandoffCrm, readHandoffNoticeConfig, renderHandoffNotice, resanitizeNoticeFacts, sanitizeNoticeText, scrubHandoffNoticeText, type HandoffCrmReading, type HandoffNoticeFacts, type HandoffNoticeTrigger,
} from "./case-handoff-notice";
import { createHandoffSlackAdapters, SLACK_NOT_POSTED_PREFIX } from "./case-handoff-slack";
import { createHandoffCrmReader, isHandoffCrmRead } from "./case-handoff-crm";
import { SAV_CASE_EFFECT_PERMISSIONS } from "./case-effects";
import { fakeSlack } from "../../../../test/sav-handoff-fakes";

/*
 * Pure layer of the Slack handoff notice, SYN data only: no database, no socket (the network is a function the test owns), no real identifier.
 * The channel, the owner and the portal below are synthetic placeholders; the real ones are injected configuration and appear in no file of the repository.
 */

const CASE = "40000000-0000-4000-8000-000000000001", INPUT = "in:gm-syn-1", TICKET = "9001";
const CHANNEL = "CSYNCHANNEL1", TOKEN = "xoxb-" + "TEST".repeat(4), PORTAL = "1234567", OWNER = "424242";
const ENV_ON = { SAV_HANDOFF_NOTICE: "on", SAV_HANDOFF_SLACK_BOT_TOKEN: TOKEN, SAV_HANDOFF_SLACK_CHANNEL_ID: CHANNEL, SAV_HANDOFF_TEAM_OWNER_ID: OWNER, HUBSPOT_PORTAL_ID: PORTAL };

const trigger = (over: Partial<Extract<HandoffNoticeTrigger, { ok: true }>["report"]> = {}, reason: (typeof HANDOFF_REASONS)[number] = "knowledge_missing"): Extract<HandoffNoticeTrigger, { ok: true }> => ({
  ok: true, caseId: CASE, ticketId: TICKET, inputKey: INPUT, recordedAtVersion: 3, reason,
  report: { need: "Le client n'arrive plus à se connecter.", expected: "Accès à la plateforme", observed: "Écran de connexion bloqué", trialIds: ["t1"], hypotheses: ["Compte désactivé"],
    missingInformation: ["Date de la dernière connexion"], expectedIntervention: "Vérifier le compte et rappeler le client.", ...over },
});
const body = { trials: [{ id: "t1", procedure: { knowledgeId: "syn-login", contentVersionId: "v1" }, outcome: "failed" }, { id: "t2", procedure: { knowledgeId: "syn-other", contentVersionId: "v1" }, outcome: "succeeded" }],
  questions: [{ id: "q1" }, { id: "q2" }] } as never;
const facts = (over: Partial<Parameters<typeof trigger>[0]> = {}): HandoffNoticeFacts => handoffNoticeFacts(trigger(over), body);
const VERIFIED = { contact: { status: "verified", id: "777", name: "Camille Synthétique" }, ticket: { status: "verified", id: TICKET } } as const;

describe("configuration: injected, off by default, fail closed", () => {
  it("only the exact value `on` enables; every missing or malformed injected value is a refusal, never a guess", () => {
    expect(readHandoffNoticeConfig({})).toEqual({ mode: "off", why: "disabled" });
    for (const value of ["true", "1", "ON", "supervised", ""]) expect(readHandoffNoticeConfig({ ...ENV_ON, SAV_HANDOFF_NOTICE: value })).toEqual({ mode: "off", why: "disabled" });
    expect(readHandoffNoticeConfig(ENV_ON)).toEqual({ mode: "on", channel: CHANNEL, teamOwnerId: OWNER, portalId: PORTAL });
    expect(readHandoffNoticeConfig({ ...ENV_ON, SAV_HANDOFF_SLACK_BOT_TOKEN: undefined })).toEqual({ mode: "off", why: "token_missing" });
    expect(readHandoffNoticeConfig({ ...ENV_ON, SAV_HANDOFF_SLACK_BOT_TOKEN: "xoxp-user-token-0000000" })).toEqual({ mode: "off", why: "token_missing" });
    expect(readHandoffNoticeConfig({ ...ENV_ON, SAV_HANDOFF_SLACK_CHANNEL_ID: undefined })).toEqual({ mode: "off", why: "channel_invalid" });
    expect(readHandoffNoticeConfig({ ...ENV_ON, SAV_HANDOFF_SLACK_CHANNEL_ID: "#sav-ia" })).toEqual({ mode: "off", why: "channel_invalid" });
    expect(readHandoffNoticeConfig({ ...ENV_ON, SAV_HANDOFF_TEAM_OWNER_ID: "not-a-number" })).toEqual({ mode: "off", why: "owner_invalid" });
    expect(readHandoffNoticeConfig({ ...ENV_ON, HUBSPOT_PORTAL_ID: "12x" })).toEqual({ mode: "off", why: "portal_invalid" });
    // The owner and the portal are optional: without them the notice still goes, just without a link or an owner.
    expect(readHandoffNoticeConfig({ ...ENV_ON, SAV_HANDOFF_TEAM_OWNER_ID: undefined, HUBSPOT_PORTAL_ID: undefined })).toEqual({ mode: "on", channel: CHANNEL, teamOwnerId: null, portalId: null });
  });

  it("the token is never part of the configuration value, so it cannot reach a ledger row", () => {
    expect(JSON.stringify(readHandoffNoticeConfig(ENV_ON))).not.toContain("xoxb");
  });
});

describe("one key and one marker per final handoff decision", () => {
  it("the key is case + input; a new input (a new mail) is a new key; an invalid id is refused", () => {
    expect(handoffNoticeKey(CASE, INPUT)).toBe(`handoff-notice:${CASE}:${INPUT}`);
    expect(handoffNoticeKey(CASE.toUpperCase(), INPUT)).toBe(handoffNoticeKey(CASE, INPUT));
    expect(handoffNoticeKey(CASE, "in:gm-syn-2")).not.toBe(handoffNoticeKey(CASE, INPUT));
    expect(() => handoffNoticeKey("not-a-uuid", INPUT)).toThrow("SAV_HANDOFF_NOTICE_KEY_INVALID");
    expect(() => handoffNoticeKey(CASE, "free text with spaces")).toThrow("SAV_HANDOFF_NOTICE_KEY_INVALID");
    expect(() => handoffNoticeKey(CASE, "in:" + "x".repeat(300))).toThrow("SAV_HANDOFF_NOTICE_KEY_INVALID");
  });

  it("the marker is stable, short, found in a text and does not reveal the key", () => {
    const key = handoffNoticeKey(CASE, INPUT), marker = handoffNoticeMarker(key);
    expect(marker).toMatch(/^HO-[0-9a-f]{12}$/);
    expect(handoffNoticeMarker(key)).toBe(marker);
    expect(handoffNoticeMarker(handoffNoticeKey(CASE, "in:gm-syn-2"))).not.toBe(marker);
    expect(handoffNoticeMarkerIn(`avant\n_Réf. ${marker}_`)).toBe(marker);
    expect(handoffNoticeMarkerIn("pas de marqueur HO-123")).toBeNull();
    expect(marker).not.toContain(CASE.slice(0, 8));
  });
});

describe("free text is made safe: no address, link, code, number or Slack control", () => {
  it("masks mail addresses, links, long codes and long numbers; strips mentions and formatting; one line; cut", () => {
    const raw = "Écrire à jean.dupont@example.invalid ou https://evil.example.invalid/x?token=abc, code ABCD1234EFGH5678IJKL9, tel 06 12 34 56 78 <!channel> <@U123|x> *gras* `code`\nligne 2";
    const safe = sanitizeNoticeText(raw, 600);
    expect(safe).not.toMatch(/@example|https?:|ABCD1234|06 12|<!channel>|<@U|\*|`|\n/);
    expect(safe).toContain("[adresse masquée]");
    expect(safe).toContain("[lien masqué]");
    expect(safe).toContain("[code masqué]");
    expect(safe).toContain("[numéro masqué]");
    expect(sanitizeNoticeText("a".repeat(400), 50)).toHaveLength(50);
    expect(sanitizeNoticeText("a".repeat(400), 50).endsWith("…")).toBe(true);
    expect(sanitizeNoticeText("texte‮retourné\u0000 propre")).toBe("texte retourné propre");
  });

  it("keeps ordinary words, accents and a short number", () => {
    expect(sanitizeNoticeText("Le client n'a pas reçu le code (3 essais) sur la plateforme Limova")).toBe("Le client n'a pas reçu le code (3 essais) sur la plateforme Limova");
  });
});

describe("the facts come from the stored decision and the cited trials only", () => {
  it("keeps the cited trials and the number of questions; sanitizes every free field", () => {
    const sealed = facts({ need: "Besoin: écrire à x@example.invalid", hypotheses: ["h1", "h2", "h3", "h4", "h5"] });
    expect(sealed.trials).toEqual([{ knowledgeId: "syn-login", outcome: "failed" }]);
    expect(sealed.questionsAsked).toBe(2);
    expect(sealed.need).toContain("[adresse masquée]");
    expect(sealed.hypotheses).toHaveLength(3);
    expect(JSON.stringify(sealed)).not.toContain("example.invalid");
  });

  it("an identifier of a knowledge card that does not look like one is masked, never copied", () => {
    const odd = handoffNoticeFacts(trigger(), { trials: [{ id: "t1", procedure: { knowledgeId: "texte libre avec @adresse x@example.invalid", contentVersionId: "v" }, outcome: "failed" }], questions: [] } as never);
    expect(odd.trials).toEqual([{ knowledgeId: "[identifiant masqué]", outcome: "failed" }]);
  });
});

describe("CRM verification: a link is shown only for what HubSpot confirmed", () => {
  const reading = (over: Partial<HandoffCrmReading> = {}): HandoffCrmReading => ({
    ticket: { id: TICKET, archived: false },
    contacts: [{ id: "777", firstname: "Camille", lastname: "Synthétique", emails: ["camille@example.invalid"], archived: false }], ...over,
  });
  const input = { ticketId: TICKET, customerEmail: "Camille@Example.invalid" };

  it("exactly one contact of the ticket carrying the customer's address (case-insensitive) is verified; the ticket is verified by its own id", () => {
    expect(judgeHandoffCrm(reading(), input)).toEqual(VERIFIED);
  });

  it.each([
    ["ticket not found", reading({ ticket: null }), "ticket_not_found"],
    ["ticket archived", reading({ ticket: { id: TICKET, archived: true } }), "ticket_not_found"],
    ["another ticket's id", reading({ ticket: { id: "1", archived: false } }), "ticket_not_found"],
    ["no associated contact", reading({ contacts: [] }), "no_matching_contact"],
    ["a contact with another address", reading({ contacts: [{ id: "778", firstname: "A", lastname: "B", emails: ["autre@example.invalid"], archived: false }] }), "no_matching_contact"],
    ["a matching but archived contact", reading({ contacts: [{ id: "777", firstname: "A", lastname: "B", emails: ["camille@example.invalid"], archived: true }] }), "no_matching_contact"],
    ["two matching contacts", reading({ contacts: [
      { id: "777", firstname: "A", lastname: "B", emails: ["camille@example.invalid"], archived: false }, { id: "778", firstname: "C", lastname: "D", emails: ["camille@example.invalid"], archived: false }] }), "several_matching_contacts"],
  ])("%s: no contact link", (_name, read, why) => {
    const verdict = judgeHandoffCrm(read, input);
    expect(verdict.contact).toMatchObject({ status: "unverified", why });
    if (why !== "ticket_not_found") expect(verdict.ticket).toEqual({ status: "verified", id: TICKET });
    else expect(verdict.ticket.status).toBe("unverified");
  });

  it("an unknown customer address never verifies a contact by name or company; a non-numeric contact id is ignored", () => {
    expect(judgeHandoffCrm(reading(), { ticketId: TICKET, customerEmail: null }).contact).toMatchObject({ status: "unverified", why: "customer_address_unknown" });
    expect(judgeHandoffCrm(reading({ contacts: [{ id: "abc", firstname: "A", lastname: "B", emails: ["camille@example.invalid"], archived: false }] }), input).contact).toMatchObject({ why: "no_matching_contact" });
  });
});

describe("the message: one template, the required sections, nothing invented", () => {
  it("has the title, the customer name with a contact link, the problem, what was tried and its result, the reason, the ticket link and the next human action", () => {
    const render = renderHandoffNotice(facts(), VERIFIED, PORTAL);
    expect(render.text.split("\n")[0]).toBe(`*${HANDOFF_NOTICE_TITLE}*`);
    expect(render.text).toContain(`Camille Synthétique — <https://app.hubspot.com/contacts/${PORTAL}/record/0-1/777|fiche contact HubSpot>`);
    expect(render.text).toContain("*Problème :* Le client n'arrive plus à se connecter.");
    expect(render.text).toContain("• Procédure syn-login : échec");
    expect(render.text).not.toContain("syn-other");
    expect(render.text).toContain("• 2 question(s) posée(s) au client");
    expect(render.text).toContain("• Attendu : Accès à la plateforme");
    expect(render.text).toContain("• Constaté : Écran de connexion bloqué");
    expect(render.text).toContain("• Hypothèse : Compte désactivé");
    expect(render.text).toContain(`*Motif du relais :* ${HANDOFF_REASON_LABELS.knowledge_missing}`);
    expect(render.text).toContain(`<https://app.hubspot.com/contacts/${PORTAL}/record/0-5/${TICKET}|ticket ${TICKET}>`);
    expect(render.text).toContain("*Prochaine action proposée :* Vérifier le compte et rappeler le client.");
    expect(render.text).toContain("Informations manquantes : Date de la dernière connexion");
    expect(render.text).toContain(`_Réf. ${render.marker}_`);
    expect(render.marker).toBe(handoffNoticeMarker(handoffNoticeKey(CASE, INPUT)));
  });

  it("every handoff reason has a label; the same facts and verdict give the same bytes", () => {
    for (const reason of HANDOFF_REASONS) expect(HANDOFF_REASON_LABELS[reason]).toMatch(/\S/);
    expect(renderHandoffNotice(facts(), VERIFIED, PORTAL)).toEqual(renderHandoffNotice(facts(), VERIFIED, PORTAL));
  });

  it("an unverified contact or ticket carries no link and says why; no portal means no link even when verified", () => {
    const none = renderHandoffNotice(facts(), { contact: { status: "unverified", why: "several_matching_contacts" }, ticket: { status: "unverified", why: "ticket_not_found" } }, PORTAL);
    expect(none.text).toContain("contact non vérifié (plusieurs contacts du ticket portent l'adresse du client), aucun lien proposé");
    expect(none.text).toContain("ticket non vérifié (ticket introuvable dans le CRM), aucun lien proposé");
    expect(none.text).not.toContain("app.hubspot.com");
    const noPortal = renderHandoffNotice(facts(), VERIFIED, null);
    expect(noPortal.text).not.toContain("app.hubspot.com");
    expect(noPortal.text).toContain("lien indisponible (portail HubSpot non configuré)");
  });

  it("without a trial, a question or an observation the notice says so instead of inventing an attempt", () => {
    const bare = handoffNoticeFacts(trigger({ expected: null, observed: null, hypotheses: [], missingInformation: [], trialIds: [] }), { trials: [], questions: [] } as never);
    const text = renderHandoffNotice(bare, VERIFIED, PORTAL).text;
    expect(text).toContain("• Aucun essai enregistré avant le relais");
    expect(text).not.toContain("Hypothèse");
    expect(text).not.toContain("Informations manquantes");
  });

  it("carries no secret, no mail address, no raw link and no owner id; stays under the size limit with huge inputs", () => {
    const hostile = trigger({ need: `Écrire à voleur@example.invalid https://evil.example.invalid ${"x".repeat(5000)}`, expectedIntervention: `${TOKEN} ${"y".repeat(5000)}`, hypotheses: Array.from({ length: 10 }, () => "z".repeat(600)) });
    const text = renderHandoffNotice(handoffNoticeFacts(hostile, body), VERIFIED, PORTAL).text;
    expect(text.length).toBeLessThanOrEqual(3500);
    expect(text).not.toMatch(/example\.invalid|evil\./);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(OWNER);
    expect(text).not.toContain(CHANNEL);
  });

  it("the intent seals the text, the marker and the channel under the notice permission; a bad channel or ticket is refused", () => {
    const render = renderHandoffNotice(facts(), VERIFIED, PORTAL);
    const intent = buildHandoffNoticeIntent({ render, caseId: CASE, ticketId: TICKET, channel: CHANNEL });
    expect(intent).toMatchObject({ kind: "handoff_notify", permission: SAV_CASE_EFFECT_PERMISSIONS.handoff, key: render.key, marker: render.marker, channel: CHANNEL, text: render.text, ticketId: TICKET, sourceMessageId: CASE });
    expect(SAV_CASE_EFFECT_PERMISSIONS.handoff).toBe("notify_case_handoff");
    expect(() => buildHandoffNoticeIntent({ render, caseId: CASE, ticketId: TICKET, channel: "#sav-ia" })).toThrow("SAV_HANDOFF_NOTICE_INTENT_INVALID");
    expect(() => buildHandoffNoticeIntent({ render, caseId: CASE, ticketId: "abc", channel: CHANNEL })).toThrow("SAV_HANDOFF_NOTICE_INTENT_INVALID");
    expect(JSON.stringify(intent)).not.toContain(TOKEN);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------
// Slack adapter on a function-shaped network
// ------------------------------------------------------------------------------------------------------------------------------------------

const intentOf = () => buildHandoffNoticeIntent({ render: renderHandoffNotice(facts(), VERIFIED, PORTAL), caseId: CASE, ticketId: TICKET, channel: CHANNEL });

describe("Slack adapter: one write, definitive refusal only when Slack says so, verification only reads", () => {
  const adapters = (slack: ReturnType<typeof fakeSlack>, env: Record<string, string | undefined> = ENV_ON) => createHandoffSlackAdapters({ network: slack.network, env: () => env });
  const signal = () => new AbortController().signal;

  it("dispatch posts once to the configured channel with the bot token, without unfurl or mentions, and returns the Slack timestamp", async () => {
    const slack = fakeSlack(), intent = intentOf();
    const ack = await adapters(slack).dispatch(intent, signal());
    expect(slack.state.calls).toHaveLength(1);
    expect(slack.state.calls[0]!.url.pathname).toBe("/api/chat.postMessage");
    expect(slack.state.calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(slack.state.calls[0]!.body).toMatchObject({ channel: CHANNEL, text: intent.text, unfurl_links: false, unfurl_media: false, link_names: false });
    expect(ack).toMatchObject({ channel: CHANNEL, ts: slack.state.messages[0]!.ts, id: slack.state.messages[0]!.ts });
    expect(JSON.stringify(ack)).not.toContain(TOKEN);
  });

  it("Slack's named refusals (nothing posted) are typed NOT_POSTED; a lost answer, a 5xx, garbage, a foreign error or a wrong channel are NOT (they may have posted)", async () => {
    for (const refusal of ["channel_not_found", "not_in_channel", "invalid_auth", "is_archived", "msg_too_long"]) {
      const slack = fakeSlack(); slack.state.mode = "refuse"; slack.state.refusal = refusal;
      await expect(adapters(slack).dispatch(intentOf(), signal())).rejects.toThrow(`${SLACK_NOT_POSTED_PREFIX}${refusal.toUpperCase()}`);
      expect(slack.state.messages).toHaveLength(0);
    }
    const limited = fakeSlack(); limited.state.mode = "ratelimit";
    await expect(adapters(limited).dispatch(intentOf(), signal())).rejects.toThrow(`${SLACK_NOT_POSTED_PREFIX}RATELIMITED`);
    for (const mode of ["lose", "http500", "garbage", "other_error", "wrong_channel"] as const) {
      const slack = fakeSlack(); slack.state.mode = mode;
      const failure = await adapters(slack).dispatch(intentOf(), signal()).then(() => null, error => (error as Error).message);
      expect(failure, mode).toBe("SAV_HANDOFF_SLACK_RESULT_UNKNOWN");
    }
  });

  it("no token: nothing is sent; a foreign intent is refused before any request", async () => {
    const slack = fakeSlack();
    await expect(adapters(slack, { ...ENV_ON, SAV_HANDOFF_SLACK_BOT_TOKEN: undefined }).dispatch(intentOf(), signal())).rejects.toThrow("SAV_HANDOFF_SLACK_TOKEN_MISSING");
    await expect(adapters(slack).dispatch({ ...intentOf(), kind: "reply_send" }, signal())).rejects.toThrow("SAV_HANDOFF_SLACK_INTENT_INVALID");
    await expect(adapters(slack).dispatch({ ...intentOf(), text: "sans marqueur" }, signal())).rejects.toThrow("SAV_HANDOFF_SLACK_INTENT_INVALID");
    expect(slack.state.calls).toHaveLength(0);
  });

  it("verify only reads (auth.test + conversations.history), finds the message by its marker and its author, and never posts", async () => {
    const slack = fakeSlack(), intent = intentOf();
    const a = adapters(slack);
    expect(await a.verify(intent, null, new Date(), signal())).toEqual({ confirmed: false, attributed: false });
    slack.state.messages.push({ text: `autre ${intent.marker} copié`, ts: "1780000500.000100", user: "UHUMAN" }); // same marker, not our author: not ours
    expect(await a.verify(intent, null, new Date(), signal())).toEqual({ confirmed: false, attributed: false });
    await a.dispatch(intent, signal());
    const proof = await a.verify(intent, null, new Date(), signal());
    expect(proof).toMatchObject({ confirmed: true, attributed: true, ack: { channel: CHANNEL, ts: slack.state.messages.at(-1)!.ts } });
    expect(slack.state.calls.filter(call => call.url.pathname === "/api/chat.postMessage")).toHaveLength(1);
    expect(slack.state.calls.every(call => call.method === "GET" || call.url.pathname === "/api/chat.postMessage")).toBe(true);
  });

  it("verify does not take a partial page for an absence, and an unavailable history is an error (read again), never `absent`", async () => {
    const slack = fakeSlack(), intent = intentOf(), a = adapters(slack);
    slack.state.hasMore = true;
    await expect(a.verify(intent, null, new Date(), signal())).rejects.toThrow("SAV_HANDOFF_SLACK_VERIFY_INCOMPLETE");
    slack.state.hasMore = false; slack.state.historyBroken = true;
    await expect(a.verify(intent, null, new Date(), signal())).rejects.toThrow("SAV_HANDOFF_SLACK_VERIFY_UNAVAILABLE");
  });

  it("two posts with the same marker (a human error) are confirmed once with the earliest timestamp and the count", async () => {
    const slack = fakeSlack(), intent = intentOf(), a = adapters(slack);
    await a.dispatch(intent, signal()); await a.dispatch(intent, signal());
    const proof = await a.verify(intent, null, new Date(), signal());
    expect(proof).toMatchObject({ confirmed: true, ack: { ts: slack.state.messages[0]!.ts, posts: 2 } });
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------
// CRM reader: read-only requests on the injected network
// ------------------------------------------------------------------------------------------------------------------------------------------

describe("CRM reader: three read-only requests, an incomplete reading throws instead of hiding a relation", () => {
  const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  function fakeCrm(over: { ticket?: () => Response; edges?: () => Response; batch?: () => Response } = {}) {
    const calls: Array<{ method: string; path: string }> = [];
    const network = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input)), method = init?.method ?? "GET";
      calls.push({ method, path: url.pathname });
      if (url.origin !== "https://api.hubapi.com") throw Error("ORIGIN_FORBIDDEN");
      if (url.pathname === `/crm/v3/objects/tickets/${TICKET}`) return over.ticket?.() ?? json(200, { id: TICKET, properties: { subject: "x" } });
      if (url.pathname === `/crm/v4/objects/tickets/${TICKET}/associations/contacts`) return over.edges?.() ?? json(200, { results: [{ toObjectId: 777 }] });
      if (url.pathname === "/crm/v3/objects/contacts/batch/read") return over.batch?.() ?? json(200, { status: "COMPLETE", results: [{ id: "777", properties: { firstname: "Camille", lastname: "Synthétique", email: "camille@example.invalid", hs_additional_emails: "alt@example.invalid;b@example.invalid" } }] });
      throw Error(`PATH_FORBIDDEN:${url.pathname}`);
    }) as typeof fetch;
    return { calls, reader: createHandoffCrmReader({ network, env: () => ({ HUBSPOT_ACCESS_TOKEN: "synthetic-crm-token" }) }) };
  }
  const run = (reader: ReturnType<typeof fakeCrm>["reader"]) => reader({ ticketId: TICKET }, new AbortController().signal);

  it("reads the ticket, its associated contacts and their addresses, and nothing else", async () => {
    const crm = fakeCrm();
    expect(await run(crm.reader)).toEqual({ ticket: { id: TICKET, archived: false },
      contacts: [{ id: "777", firstname: "Camille", lastname: "Synthétique", emails: ["camille@example.invalid", "alt@example.invalid", "b@example.invalid"], archived: false }] });
    expect(crm.calls).toEqual([{ method: "GET", path: `/crm/v3/objects/tickets/${TICKET}` }, { method: "GET", path: `/crm/v4/objects/tickets/${TICKET}/associations/contacts` }, { method: "POST", path: "/crm/v3/objects/contacts/batch/read" }]);
    expect(crm.calls.every(call => isHandoffCrmRead(call.path, call.method))).toBe(true);
  });

  it("the allowlist refuses every write and every other read", () => {
    expect(isHandoffCrmRead(`/crm/v3/objects/tickets/${TICKET}`, "PATCH")).toBe(false);
    expect(isHandoffCrmRead(`/crm/v3/objects/tickets/${TICKET}`, "DELETE")).toBe(false);
    expect(isHandoffCrmRead("/crm/v3/objects/notes", "POST")).toBe(false);
    expect(isHandoffCrmRead("/crm/v3/objects/contacts/777", "GET")).toBe(false);
    expect(isHandoffCrmRead("/crm/v3/objects/contacts/batch/read", "POST")).toBe(true);
  });

  it("a ticket that does not exist is a reading (absent ticket); a failed, partial or paged reading throws", async () => {
    expect(await run(fakeCrm({ ticket: () => json(404, {}) }).reader)).toEqual({ ticket: null, contacts: [] });
    expect(await run(fakeCrm({ ticket: () => json(200, { id: "1" }) }).reader)).toEqual({ ticket: null, contacts: [] });
    await expect(run(fakeCrm({ ticket: () => json(500, {}) }).reader)).rejects.toThrow("SAV_HANDOFF_CRM_UNREADABLE");
    await expect(run(fakeCrm({ edges: () => json(200, { results: [{ toObjectId: 777 }], paging: { next: { after: "1" } } }) }).reader)).rejects.toThrow("SAV_HANDOFF_CRM_UNREADABLE");
    await expect(run(fakeCrm({ batch: () => json(207, { status: "COMPLETE", results: [], errors: [{ id: "777" }] }) }).reader)).rejects.toThrow("SAV_HANDOFF_CRM_UNREADABLE");
    await expect(run(fakeCrm({ batch: () => json(200, { status: "COMPLETE", results: [] }) }).reader)).rejects.toThrow("SAV_HANDOFF_CRM_UNREADABLE");
    await expect(run(fakeCrm({ batch: () => json(200, "not json object") }).reader)).rejects.toThrow("SAV_HANDOFF_CRM_UNREADABLE");
  });

  it("a ticket without any associated contact needs no contact read; an invalid ticket id or a missing token fails before any request", async () => {
    const empty = fakeCrm({ edges: () => json(200, { results: [] }) });
    expect(await run(empty.reader)).toEqual({ ticket: { id: TICKET, archived: false }, contacts: [] });
    expect(empty.calls).toHaveLength(2);
    const calls: string[] = [];
    const reader = createHandoffCrmReader({ network: (async () => { calls.push("x"); throw Error("NO"); }) as never, env: () => ({}) });
    await expect(reader({ ticketId: TICKET }, new AbortController().signal)).rejects.toThrow("SAV_HANDOFF_CRM_TOKEN_MISSING");
    await expect(createHandoffCrmReader({ network: fetch, env: () => ({ HUBSPOT_ACCESS_TOKEN: "t" }) })({ ticketId: "../x" }, new AbortController().signal)).rejects.toThrow("SAV_HANDOFF_CRM_TICKET_INVALID");
    expect(calls).toHaveLength(0);
  });
});

describe("review A10: no one-time code, token, link, address or number reaches Slack; our own CRM links stay", () => {
  const hostile = [
    ["a six-digit one-time code", "le code de connexion 718236", "718236"],
    ["the same code spaced", "code reçu : 718 236", "718"],
    ["a code named by its word", "mon mot de passe est Azerty123", "Azerty123"],
    ["a short alphanumeric code", "le code AB12CD de vérification", "AB12CD"],
    ["a Slack token", `jeton xoxb-${"1234".repeat(3)}-${"TEST".repeat(4)} collé par le client`, "xoxb-"],
    ["a bearer header", "en-tête Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig reçu", "eyJ"],
    ["a long hexadecimal secret", "clé 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", "9f86d081"],
    ["an IBAN", "virement FR76 3000 6000 0112 3456 7890 189", "3000"],
    ["a phone number", "rappeler le 06 12 34 56 78", "06 12"],
    ["a card number", "carte 4111 1111 1111 1111", "4111"],
    ["a mail address and a link", "voleur@example.invalid via https://evil.example.invalid/x?otp=1", "evil.example"],
    ["a Slack mention", "<!channel> <@U123|boss> <#C123|general>", "channel"],
  ] as const;

  it("every free-text rule masks its secret, in the sentence and in the facts", () => {
    for (const [label, text, secret] of hostile) {
      const safe = sanitizeNoticeText(`Le client dit : ${text}.`);
      expect(safe, label).not.toContain(secret);
      expect(sanitizeNoticeText(safe), `${label}: idempotent`).toBe(safe);
      const sealed = facts({ need: text, expected: text, observed: text, hypotheses: [text], missingInformation: [text], expectedIntervention: text });
      expect(JSON.stringify(sealed), label).not.toContain(secret);
    }
    // Ordinary words and short numbers are kept.
    expect(sanitizeNoticeText("Le client a fait 3 essais sur la version 2 de l'écran")).toBe("Le client a fait 3 essais sur la version 2 de l'écran");
  });

  it("the rendered notice carries none of them, whatever the facts; the CRM links, the ticket number and the marker stay", () => {
    const text = hostile.map(([, value]) => value).join(" ; ");
    const sealed = facts({ need: text, expectedIntervention: text, hypotheses: [text], missingInformation: [text] });
    const render = renderHandoffNotice(sealed, VERIFIED, PORTAL);
    for (const [label, , secret] of hostile) expect(render.text, label).not.toContain(secret);
    expect(render.text).toContain(`<https://app.hubspot.com/contacts/${PORTAL}/record/0-1/777|fiche contact HubSpot>`);
    expect(render.text).toContain(`<https://app.hubspot.com/contacts/${PORTAL}/record/0-5/${TICKET}|ticket ${TICKET}>`);
    expect(render.text).toContain(`_Réf. ${render.marker}_`);
    expect(handoffNoticeMarkerIn(render.text)).toBe(render.marker);
  });

  it("facts sealed BEFORE the rule are cleaned again when the notice is rendered (historical records)", () => {
    const old: HandoffNoticeFacts = { ...facts(), need: "Le client a reçu le code 718236 et le répète", expectedIntervention: "Appeler le 06 12 34 56 78", hypotheses: ["mot de passe : Azerty123"] };
    expect(JSON.stringify(old)).toContain("718236");
    const render = renderHandoffNotice(old, VERIFIED, PORTAL);
    expect(render.text).not.toMatch(/718236|06 12|Azerty123/);
    expect(JSON.stringify(resanitizeNoticeFacts(old))).not.toMatch(/718236|06 12|Azerty123/);
  });

  it("the last look scrubs a text already sealed in the ledger: free-text lines are cleaned, foreign <...> are removed, our links and the marker are kept", () => {
    const sealed = renderHandoffNotice(facts(), VERIFIED, PORTAL);
    const historical = sealed.text
      .replace(/(\*Problème :\* ).*/, "$1le code 718236 <!channel> https://evil.example.invalid voleur@example.invalid")
      .replace(/(\*Prochaine action proposée :\* ).*/, "$1Appeler le 06 12 34 56 78 <@U123|boss>");
    expect(historical).toContain("718236");
    const scrubbed = scrubHandoffNoticeText(historical);
    expect(scrubbed).not.toMatch(/718236|evil\.example|voleur|06 12|<!channel>|<@U123/);
    expect(scrubbed).toContain("[adresse masquée]");
    expect(scrubbed).toContain(`<https://app.hubspot.com/contacts/${PORTAL}/record/0-1/777|fiche contact HubSpot>`);
    expect(scrubbed).toContain(`<https://app.hubspot.com/contacts/${PORTAL}/record/0-5/${TICKET}|ticket ${TICKET}>`);
    expect(handoffNoticeMarkerIn(scrubbed)).toBe(sealed.marker);
    // A link that only looks like ours (other host, other path) does not survive.
    expect(scrubHandoffNoticeText("*Problème :* x\n*Ticket HubSpot :* <https://app.hubspot.com.evil.example/contacts/1/record/0-5/2|ticket 2> <https://app.hubspot.com/files/1|x>")).not.toContain("<");
    // Our own output is a fixed point.
    expect(scrubHandoffNoticeText(sealed.text)).toBe(sealed.text);
  });

  it("the Slack adapter posts the scrubbed text even for an intent sealed under the old rule; the marker still verifies", async () => {
    const slack = fakeSlack();
    const sealed = renderHandoffNotice(facts(), VERIFIED, PORTAL);
    const intent = { ...buildHandoffNoticeIntent({ render: { ...sealed, text: sealed.text.replace(/(\*Problème :\* ).*/, "$1code 718236 voleur@example.invalid <!channel>") }, caseId: CASE, ticketId: TICKET, channel: CHANNEL }) };
    await createHandoffSlackAdapters({ network: slack.network, env: () => ENV_ON }).dispatch(intent, new AbortController().signal);
    const posted = slack.state.messages[0]!.text;
    expect(posted).not.toMatch(/718236|voleur|<!channel>/);
    expect(posted).toContain("[adresse masquée]");
    expect(posted).toContain(`record/0-5/${TICKET}|ticket ${TICKET}>`);
    expect(handoffNoticeMarkerIn(posted)).toBe(intent.marker);
  });
});
