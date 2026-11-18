import { describe, expect, it, vi } from "vitest";
import type { GmailRequest } from "../intake/execution-adapters";
import { prepareCaseReplyText } from "./case-reply-outbound";
import { buildNewThreadSendIntent, createThreadlessTransport, THREADLESS_MAILBOX } from "./threadless-transport";

const on = () => ({ SAV_V2_NEW_THREAD: "on" });
const signal = new AbortController().signal;
const dispatchedAt = new Date("2026-11-18T12:00:00.000Z");
const sentAt = "2026-11-18T12:00:01.000Z";
const ack = { id: "synthetic-message", threadId: "synthetic-thread" };
const draft = {
  key: "new-thread:fixture:42",
  ticketId: "42",
  recipient: "customer@example.invalid",
  subject: "Aide à la connexion [42]",
  text: prepareCaseReplyText("Bonjour,\n\nQue voyez-vous à l’écran ?", "fr", "manual_reviewed", "question"),
};
const intent = buildNewThreadSendIntent(draft);
const crmReceipt = { ...ack, sentAt };
const headers = [
  { name: "From", value: THREADLESS_MAILBOX },
  { name: "To", value: draft.recipient },
  { name: "Subject", value: draft.subject },
  { name: "Message-ID", value: intent.rfcMessageId },
];
const rawMail = {
  ...ack,
  internalDate: String(Date.parse(sentAt)),
  labelIds: ["SENT"],
  payload: { mimeType: "text/plain", body: { data: Buffer.from(draft.text).toString("base64url") }, headers },
};

function gmailFixture(list: unknown = { messages: [ack] }, message: unknown = rawMail) {
  const calls: { mailbox: string; path: string; init?: RequestInit }[] = [];
  const gmailRequest: GmailRequest = async <T>(mailbox: string, path: string, init?: RequestInit) => {
    calls.push({ mailbox, path, init });
    if (path === "messages/send") return ack as T;
    if (path.startsWith("messages?")) return list as T;
    if (path === `messages/${ack.id}?format=full`) return message as T;
    throw new Error("UNEXPECTED_GMAIL_PATH");
  };
  return { calls, gmailRequest };
}

describe("SAV-96 new-thread Gmail transport", () => {
  it("uses one deterministic Message-ID and transmits only the exact approved MIME", async () => {
    const { calls, gmailRequest } = gmailFixture();
    expect(buildNewThreadSendIntent(draft)).toEqual(intent);
    expect(buildNewThreadSendIntent({ ...draft, key: "new-thread:fixture:43" }).rfcMessageId).not.toBe(intent.rfcMessageId);
    expect(intent).toMatchObject({ kind: "new_thread_send", permission: "send_case_new_thread" });
    const [head, body] = intent.raw.split("\r\n\r\n");
    expect(head).toContain(`From: ${THREADLESS_MAILBOX}`);
    expect(head).toContain(`To: ${draft.recipient}`);
    expect(head).not.toMatch(/^(?:In-Reply-To|References|Cc|Bcc):/im);
    expect(Buffer.from(body!, "base64").toString("utf8")).toBe(draft.text);
    expect(await createThreadlessTransport({ gmailRequest, env: on }).send(intent, signal)).toEqual(ack);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ mailbox: THREADLESS_MAILBOX, path: "messages/send", init: { method: "POST" } });
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ raw: Buffer.from(intent.raw).toString("base64url") });
  });

  it.each([
    { recipient: "unverified" },
    { subject: "Re: Aide à la connexion" },
    { subject: "Objet\r\nBcc: unexpected@example.invalid" },
    { text: "Texte sans mention de validation." },
  ])("refuses an invalid intent (%j)", invalid => {
    expect(() => buildNewThreadSendIntent({ ...draft, ...invalid })).toThrow("SAV_THREADLESS_INTENT_INVALID");
  });

  it("makes no transport call when disabled, when the allowlist blocks, or if the raw MIME was changed", async () => {
    const { calls, gmailRequest } = gmailFixture();
    await expect(createThreadlessTransport({ gmailRequest, env: () => ({}) }).send(intent, signal)).rejects.toThrow("SAV_THREADLESS_WRITES_DISABLED");
    await expect(createThreadlessTransport({ gmailRequest, env: () => ({ ...on(), SAV_TEST_MODE: "true" }) }).send(intent, signal))
      .rejects.toThrow("SAV_TEST_OUTBOUND_RECIPIENT_BLOCKED");
    await expect(createThreadlessTransport({ gmailRequest, env: on }).send({ ...intent, raw: `Bcc: other@example.invalid\r\n${intent.raw}` }, signal))
      .rejects.toThrow("SAV_THREADLESS_INTENT_INVALID");
    expect(calls).toEqual([]);
  });

  it.each([null, ack])("attributes the unique matching SENT message after dispatch with ACK %j", async receipt => {
    const { calls, gmailRequest } = gmailFixture();
    const disabled = createThreadlessTransport({ gmailRequest, env: () => ({}) });
    expect(await disabled.verifySent(intent, receipt, dispatchedAt, signal)).toEqual(crmReceipt);
    expect(calls).toHaveLength(2);
    expect(new URLSearchParams(calls[0]!.path.split("?")[1]).get("q")).toBe(`in:sent rfc822msgid:${intent.rfcMessageId}`);
    expect(calls.every(call => call.mailbox === THREADLESS_MAILBOX && !call.init?.method)).toBe(true);
  });

  it.each([
    { messages: [] },
    { messages: [ack, { ...ack, id: "duplicate-message" }] },
    { messages: [ack], nextPageToken: "more" },
  ])("leaves empty, duplicate or incomplete search results uncertain (%j)", async list => {
    const { calls, gmailRequest } = gmailFixture(list);
    expect(await createThreadlessTransport({ gmailRequest, env: on }).verifySent(intent, null, dispatchedAt, signal)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.method).toBeUndefined();
  });

  it.each([
    ["sender", { name: "From", value: "other@example.invalid" }],
    ["recipient", { name: "To", value: "other@example.invalid" }],
    ["subject", { name: "Subject", value: "Un autre sujet" }],
    ["Message-ID", { name: "Message-ID", value: "<other@example.invalid>" }],
    ["reply parent", { name: "In-Reply-To", value: "<old@example.invalid>" }],
    ["references", { name: "References", value: "<old@example.invalid>" }],
    ["CC", { name: "Cc", value: "other@example.invalid" }],
    ["BCC", { name: "Bcc", value: "" }],
  ] as const)("refuses read-back with a changed %s", async (_field, wrong) => {
    const message = { ...rawMail, payload: { ...rawMail.payload, headers: [...headers.filter(header => header.name !== wrong.name), wrong] } };
    const { gmailRequest } = gmailFixture({ messages: [ack] }, message);
    expect(await createThreadlessTransport({ gmailRequest, env: on }).verifySent(intent, ack, dispatchedAt, signal)).toBeNull();
  });

  it.each([
    { ...rawMail, labelIds: ["DRAFT"] },
    { ...rawMail, internalDate: String(dispatchedAt.getTime() - 61_000) },
    { ...rawMail, payload: { ...rawMail.payload, headers: [...headers, headers[0]] } },
    { ...rawMail, payload: { ...rawMail.payload, body: { data: Buffer.from(draft.text + "\n").toString("base64url") } } },
    { ...rawMail, payload: { ...rawMail.payload, mimeType: "text/html" } },
  ])("refuses a message with changed labels, timestamp, header count, text or MIME type", async message => {
    const { gmailRequest } = gmailFixture({ messages: [ack] }, message);
    expect(await createThreadlessTransport({ gmailRequest, env: on }).verifySent(intent, ack, dispatchedAt, signal)).toBeNull();
  });
});

describe("SAV-96 threadless CRM transport", () => {
  const crmAck = { id: "17" };
  const label = (typeId: number) => Response.json({ results: [{ typeId, category: "HUBSPOT_DEFINED", label: null }] });

  it("creates the outbound activity with ticket and contact links and proves both from the provider", async () => {
    let properties: Record<string, string> | undefined;
    let linkedContact = "24";
    const network = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/crm/v4/associations/emails/tickets/labels") return label(222);
      if (path === "/crm/v4/associations/emails/contacts/labels") return label(198);
      if (path === "/crm/v3/objects/emails" && init?.method === "POST") {
        const request = JSON.parse(String(init.body));
        expect(request.associations).toEqual([
          { to: { id: "42" }, types: [{ associationTypeId: 222, associationCategory: "HUBSPOT_DEFINED" }] },
          { to: { id: "24" }, types: [{ associationTypeId: 198, associationCategory: "HUBSPOT_DEFINED" }] },
        ]);
        properties = request.properties;
        expect(properties).toMatchObject({ hs_email_status: "SENT", hs_email_direction: "EMAIL", hs_email_subject: draft.subject, hs_email_text: draft.text, hs_timestamp: sentAt });
        return Response.json(crmAck);
      }
      if (path === "/crm/v3/objects/emails/17") return Response.json({ ...crmAck, properties });
      if (path === "/crm/v4/objects/emails/17/associations/tickets") return Response.json({ results: [{ toObjectId: 42 }] });
      if (path === "/crm/v4/objects/emails/17/associations/contacts") return Response.json({ results: [{ toObjectId: linkedContact }] });
      throw Error("UNEXPECTED_HUBSPOT_PATH");
    });
    const transport = createThreadlessTransport({ network, env: on });
    expect(await transport.createCrmEmail(intent, crmReceipt, "24", signal)).toEqual(crmAck);
    expect(await transport.verifyCrmEmail(intent, crmReceipt, "24", crmAck, signal)).toEqual(crmAck);
    linkedContact = "25";
    expect(await transport.verifyCrmEmail(intent, crmReceipt, "24", crmAck, signal)).toBeNull();
    expect(network.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("attempts the CRM write once when it fails and does not dispatch during recovery", async () => {
    const { calls, gmailRequest } = gmailFixture();
    const network = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      if (init?.method === "POST") return Response.json({}, { status: 503 });
      if (String(input).endsWith("/labels")) return label(40);
      throw Error("UNEXPECTED_HUBSPOT_PATH");
    });
    const transport = createThreadlessTransport({ network, gmailRequest, env: on });
    await expect(transport.createCrmEmail(intent, crmReceipt, "24", signal)).rejects.toThrow("HUBSPOT_HTTP_503");
    expect(await transport.verifyCrmEmail(intent, crmReceipt, "24", null, signal)).toBeNull();
    expect(network.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(calls).toEqual([]);
  });
});
