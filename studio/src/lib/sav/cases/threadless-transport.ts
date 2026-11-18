import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { requestSavGmail } from "../gmail";
import { createSavHubspotTransport } from "../hubspot-transport";
import { exactMimeText, oneAddress, type GmailRequest } from "../intake/execution-adapters";
import { isSavOutboundRecipientAllowed } from "../policy";
import { readCaseReplyDisclosure } from "./case-reply-outbound";
import { savV2NewThreadEnabled, THREADLESS_SEND_PERMISSION } from "./threadless-config";

export const THREADLESS_MAILBOX = "contact@limova.ai";

const mailboxAddress = z.email().max(254);
const crmId = z.string().regex(/^\d{1,30}$/);
const gmailRef = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const gmailAck = z.object({ id: gmailRef, threadId: gmailRef });
const crmAck = z.object({ id: crmId });
const gmailList = z.object({ messages: z.array(gmailAck).optional(), nextPageToken: z.string().optional() });
const gmailMessage = gmailAck.extend({
  internalDate: z.string().regex(/^\d+$/),
  labelIds: z.array(z.string()),
  payload: z.object({ headers: z.array(z.object({ name: z.string(), value: z.string() })) }).passthrough(),
});

export type NewThreadAck = z.infer<typeof gmailAck>;
export type NewThreadReceipt = NewThreadAck & Readonly<{ sentAt: string }>;
export type ThreadlessCrmAck = z.infer<typeof crmAck>;

type Draft = Readonly<{ key: string; ticketId: string; recipient: string; subject: string; text: string }>;
export type NewThreadSendIntent = Draft & Readonly<{
  kind: "new_thread_send";
  permission: typeof THREADLESS_SEND_PERMISSION;
  mailbox: typeof THREADLESS_MAILBOX;
  rfcMessageId: string;
  raw: string;
}>;

// Fold encoded words at Unicode character boundaries, within the RFC 2047 limit.
function mimeSubject(subject: string) {
  if (/^[\x20-\x7e]+$/.test(subject) && !subject.includes("=?")) return subject;
  const words: string[] = [];
  let chunk = "";
  const encode = (word: string) => `=?UTF-8?B?${Buffer.from(word).toString("base64")}?=`;
  for (const character of subject) {
    if (Buffer.byteLength(chunk + character) > 42) {
      words.push(encode(chunk));
      chunk = "";
    }
    chunk += character;
  }
  words.push(encode(chunk));
  return words.join("\r\n ");
}

export function buildNewThreadSendIntent(input: Draft): NewThreadSendIntent {
  const { key, ticketId, subject, text } = input;
  const recipient = input.recipient.trim().toLowerCase();
  if (!crmId.safeParse(ticketId).success || !mailboxAddress.safeParse(recipient).success || recipient === THREADLESS_MAILBOX
    || !/^[\w.:+-]{10,420}$/.test(key)
    || !subject || subject !== subject.trim() || subject.length > 200 || /[\p{Cc}\p{Cs}\u2028\u2029]/u.test(subject)
    || /^(?:re|fw|fwd|tr)\s*:/i.test(subject)
    || text.length > 50_000 || /[\0\p{Cs}]/u.test(text) || !readCaseReplyDisclosure(text)) throw Error("SAV_THREADLESS_INTENT_INVALID");
  const rfcMessageId = `<sav-case-new-${createHash("sha256").update(`${ticketId}\0${key}`).digest("hex")}@studio.limova.ai>`;
  const raw = [
    `From: ${THREADLESS_MAILBOX}`, `To: ${recipient}`, `Subject: ${mimeSubject(subject)}`, `Message-ID: ${rfcMessageId}`,
    "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "",
    Buffer.from(text).toString("base64").replace(/.{76}(?=.)/g, "$&\r\n"),
  ].join("\r\n");
  return { key, ticketId, recipient, subject, text, kind: "new_thread_send", permission: THREADLESS_SEND_PERMISSION, mailbox: THREADLESS_MAILBOX, rfcMessageId, raw };
}

function assertSealedIntent(intent: NewThreadSendIntent) {
  const expected = buildNewThreadSendIntent(intent);
  if (expected.kind !== intent.kind || expected.permission !== intent.permission || expected.mailbox !== intent.mailbox
    || expected.recipient !== intent.recipient || expected.raw !== intent.raw || expected.rfcMessageId !== intent.rfcMessageId)
    throw Error("SAV_THREADLESS_INTENT_INVALID");
}

function crmProperties(intent: NewThreadSendIntent, receipt: NewThreadReceipt) {
  return {
    hs_timestamp: z.iso.datetime().parse(receipt.sentAt),
    hs_email_direction: "EMAIL",
    hs_email_status: "SENT",
    hs_email_subject: intent.subject,
    hs_email_text: intent.text,
    hs_email_headers: JSON.stringify({ from: { email: intent.mailbox }, to: [{ email: intent.recipient }], cc: [], bcc: [] }),
  };
}

function crmHeadersMatch(value: string | null | undefined, intent: NewThreadSendIntent) {
  if (!value) return false;
  const email = z.object({ email: mailboxAddress });
  const schema = z.object({ from: email, to: z.array(email).length(1), cc: z.array(z.unknown()).length(0).optional(),
    bcc: z.array(z.unknown()).length(0).optional() });
  let headers: unknown;
  try { headers = JSON.parse(value); } catch { return false; }
  const observed = schema.safeParse(headers);
  return observed.success && observed.data.from.email.toLowerCase() === intent.mailbox
    && observed.data.to[0]?.email.toLowerCase() === intent.recipient;
}

export function createThreadlessTransport(options: {
  gmailRequest?: GmailRequest;
  network?: typeof fetch;
  env?: () => Record<string, string | undefined>;
} = {}) {
  const gmail = options.gmailRequest ?? requestSavGmail;
  const network = options.network ?? fetch;
  const env = options.env ?? (() => process.env);
  const hubspot = createSavHubspotTransport((url, init) => network(url, {
    ...init,
    redirect: "error",
    headers: {
      ...Object.fromEntries(new Headers(init?.headers)),
      Authorization: `Bearer ${env().HUBSPOT_ACCESS_TOKEN ?? ""}`,
    },
  }));
  const hub = (path: string, signal: AbortSignal, body?: unknown) => hubspot<unknown>(path, {
    signal, method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", Accept: "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, status => `HUBSPOT_HTTP_${status}`);
  const targets = ["tickets", "contacts"] as const;
  async function associationType(target: typeof targets[number], signal: AbortSignal) {
    const data = z.object({ results: z.array(z.object({ category: z.string(), typeId: z.number().int().positive(), label: z.string().nullable() })) })
      .parse(await hub(`/crm/v4/associations/emails/${target}/labels`, signal));
    const matching = data.results.filter(row => row.category === "HUBSPOT_DEFINED" && row.label === null);
    if (matching.length !== 1) throw Error("SAV_THREADLESS_CRM_ASSOCIATION_UNPROVEN");
    return matching[0]!.typeId;
  }
  async function associated(emailId: string, target: typeof targets[number], targetId: string, signal: AbortSignal) {
    const data = z.object({
      results: z.array(z.object({ toObjectId: z.union([crmId, z.number().int().nonnegative().safe()]) })),
      paging: z.unknown().optional(),
    }).parse(await hub(`/crm/v4/objects/emails/${emailId}/associations/${target}?limit=2`, signal));
    return !data.paging && data.results.length === 1 && String(data.results[0]?.toObjectId) === targetId;
  }
  function assertWriteEnabled() {
    const current = env();
    if (!savV2NewThreadEnabled(current) || current.SAV_WRITES_DISABLED === "true" || current.SAV_INTAKE_EXECUTION_KILL_SWITCH === "1") {
      throw Error("SAV_THREADLESS_WRITES_DISABLED");
    }
    return current;
  }

  return {
    async send(intent: NewThreadSendIntent, signal: AbortSignal): Promise<NewThreadAck> {
      assertSealedIntent(intent);
      const current = assertWriteEnabled();
      if (!isSavOutboundRecipientAllowed(intent.recipient, {
        testMode: current.SAV_TEST_MODE === "true", allowlist: current.SAV_TEST_OUTBOUND_ALLOWLIST ?? "",
      })) throw Error("SAV_TEST_OUTBOUND_RECIPIENT_BLOCKED");
      return gmailAck.parse(await gmail<unknown>(THREADLESS_MAILBOX, "messages/send", {
        method: "POST", signal, body: JSON.stringify({ raw: Buffer.from(intent.raw).toString("base64url") }),
      }));
    },
    async verifySent(intent: NewThreadSendIntent, ack: NewThreadAck | null, dispatchedAt: Date, signal: AbortSignal): Promise<NewThreadReceipt | null> {
      assertSealedIntent(intent);
      if (!Number.isFinite(dispatchedAt.getTime()) || ack && !gmailAck.safeParse(ack).success) return null;
      const query = new URLSearchParams({ q: `in:sent rfc822msgid:${intent.rfcMessageId}`, maxResults: "2" });
      const list = gmailList.parse(await gmail<unknown>(THREADLESS_MAILBOX, `messages?${query}`, { signal }));
      if (list.nextPageToken !== undefined || list.messages?.length !== 1) return null;
      const [found] = list.messages;
      if (!found || ack && (ack.id !== found.id || ack.threadId !== found.threadId)) return null;
      const message = gmailMessage.parse(await gmail<unknown>(THREADLESS_MAILBOX, `messages/${found.id}?format=full`, { signal }));
      const header = (name: string) => message.payload.headers.filter(item => item.name.toLowerCase() === name).map(item => item.value);
      const at = Number(message.internalDate);
      if (message.id !== found.id || message.threadId !== found.threadId || !message.labelIds.includes("SENT")
        || !Number.isSafeInteger(at) || at < dispatchedAt.getTime() - 60_000 || at > dispatchedAt.getTime() + 600_000
        || ["from", "to", "subject", "message-id"].some(name => header(name).length !== 1)
        || ["in-reply-to", "references", "cc", "bcc"].some(name => header(name).length !== 0)
        || oneAddress(header("from")[0]!) !== THREADLESS_MAILBOX || oneAddress(header("to")[0]!) !== intent.recipient
        || header("message-id")[0] !== intent.rfcMessageId) return null;
      const observedSubject = header("subject")[0]!;
      if (observedSubject !== intent.subject && observedSubject.replace(/\r?\n[ \t]+/g, " ") !== mimeSubject(intent.subject).replace(/\r\n /g, " ")) return null;
      if (exactMimeText(message.payload) !== intent.text) return null;
      return { id: message.id, threadId: message.threadId, sentAt: new Date(at).toISOString() };
    },
    async createCrmEmail(intent: NewThreadSendIntent, receipt: NewThreadReceipt, contactId: string, signal: AbortSignal): Promise<ThreadlessCrmAck> {
      assertSealedIntent(intent);
      assertWriteEnabled();
      const targetIds = [intent.ticketId, crmId.parse(contactId)];
      const types = await Promise.all(targets.map(target => associationType(target, signal)));
      assertWriteEnabled();
      return crmAck.parse(await hub("/crm/v3/objects/emails", signal, {
        properties: crmProperties(intent, receipt),
        associations: types.map((associationTypeId, index) => ({
          to: { id: targetIds[index] }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId }],
        })),
      }));
    },
    async verifyCrmEmail(intent: NewThreadSendIntent, receipt: NewThreadReceipt, contactId: string, ack: ThreadlessCrmAck | null, signal: AbortSignal): Promise<ThreadlessCrmAck | null> {
      assertSealedIntent(intent);
      // A lost CRM creation ACK leaves only a human reconciliation. Email text is not an ownership marker.
      if (!ack) return null;
      const emailId = crmId.parse(ack.id);
      const expected = crmProperties(intent, receipt);
      const fields = new URLSearchParams({ properties: Object.keys(expected).join(",") });
      const row = z.object({ id: crmId, archived: z.boolean().optional(), properties: z.record(z.string(), z.string().nullable()) })
        .parse(await hub(`/crm/v3/objects/emails/${emailId}?${fields}`, signal));
      if (row.id !== emailId || row.archived || !crmHeadersMatch(row.properties.hs_email_headers, intent)) return null;
      for (const [key, value] of Object.entries(expected)) {
        if (key === "hs_email_headers") continue;
        const observed = row.properties[key] ?? "";
        if (key === "hs_timestamp") {
          const observedAt = /^\d+$/.test(observed) ? Number(observed) : Date.parse(observed);
          if (observedAt !== Date.parse(value)) return null;
        } else if (observed !== value) return null;
      }
      const links = await Promise.all([associated(emailId, "tickets", intent.ticketId, signal), associated(emailId, "contacts", crmId.parse(contactId), signal)]);
      return links.every(Boolean) ? { id: emailId } : null;
    },
  };
}
