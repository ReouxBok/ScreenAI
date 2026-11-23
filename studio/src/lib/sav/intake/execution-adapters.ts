import "server-only";
import { collectTicketCreationHistory, ticketCreationAssociations, ticketCreationHistorySchema, verifyTicketCreationHistory } from "../ticket-creation-history";
import { z } from "zod";
import { createSavHubspotTransport } from "../hubspot-transport";
import { SAV_HUBSPOT_SUPPORT } from "../hubspot-mapping";
import { createSavIntakeHubspotReaders } from "./hubspot-readers";
import { requestSavGmail, parseGmailMessage } from "../gmail";
import { readSavGmailPermissions } from "../gmail-permissions";
import { collectExecutionCrm, executionScopeKeys } from "./execution-context";
import { qualifyCrmHistoryAdditions } from "./crm-continuation";
import type { ExecutorAdapters, EffectAck, EffectIntent } from "./execution-types";
const id = (s: string | undefined) => z.string().regex(/^\d{1,30}$/).parse(s);
const object = (v: unknown) => z.object({
    id: z.string(), properties: z.record(z.string(), z.string().nullable())
}).parse(v);
const plain = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
export const renderIntakeNote = (text: string, marker: string) => `<p>${plain(text).replace(/\n/g, "<br>")}</p><p>[Studio intake: ${plain(marker)}]</p>`;
/** SAV-92 (16/11): a note shown to the team with NO visible identifier (the V2 reply's summary note). Its marker is the historical hidden comment, which HubSpot
 * may remove: the note is then proven only by its creation ACK (as before). With neither the ACK nor the hidden comment, nothing proves which note is ours (the
 * summary is deterministic, two cases can share its text and instant): it stays uncertain, never attributed on its date and text. */
export const renderIntakeNoteHidden = (text: string, marker: string) => `<p>${plain(text).replace(/\n/g, "<br>")}</p><!-- sav-intake:${marker} -->`;
/** Only the V2 reply's summary note (`note:<case>:reply-summary.<trigger>`) and the V2 closure note (`note:<case>:closed-summary.cycle-<n>`, SAV-92 16/11) are
 * rendered without a visible marker; every other note keeps the visible one. */
export const hiddenMarkerNoteKey = (key: string | undefined) => typeof key === "string" && /^note:[^:]+:(?:reply|closed|handoff)-summary\./.test(key);
/** 18/11 (SAV-93): HubSpot's default note → ticket association type (HUBSPOT_DEFINED 228), sent with the note's creation so it is born on the ticket. */
export const HUBSPOT_NOTE_TO_TICKET = 228;
const ENTITIES: Readonly<Record<string, string>> = {
    amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", rsquo: "'", lsquo: "'", ldquo: "\"", rdquo: "\"", laquo: "«", raquo: "»", hellip: "…", ndash: "–", mdash: "—", euro: "€",
    eacute: "é", egrave: "è", ecirc: "ê", euml: "ë", agrave: "à", acirc: "â", ccedil: "ç", icirc: "î", iuml: "ï", ocirc: "ô", ugrave: "ù", ucirc: "û", uuml: "ü",
    Eacute: "É", Egrave: "È", Ecirc: "Ê", Agrave: "À", Acirc: "Â", Ccedil: "Ç", Ocirc: "Ô", Ucirc: "Û",
};
/**
 * 18/11 (SAV-93): the TEXT a person reads in a note body, whatever HTML HubSpot stores it as: comments removed (the hidden marker), line breaks and paragraphs
 * as spaces, other tags dropped, entities decoded (named, decimal, hex), typographic quotes and non-breaking spaces folded, whitespace collapsed. HubSpot may
 * rewrite the HTML it was sent (an apostrophe as `&#x27;` or `’`, `<br>` as `<br/>`, a wrapper, a removed comment): the first V2 note stayed unproven on byte
 * equality. Used ONLY where the note's identity is already anchored by its creation ACK (and, for a V2 case note, by its ticket association).
 */
export function noteBodyText(html: string) {
    const decoded = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<br\s*\/?>|<\/(?:p|div|li)>/gi, " ").replace(/<[^>]*>/g, "")
        .replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]+);/gi, (all, name: string) => {
            if (name[0] !== "#") return Object.hasOwn(ENTITIES, name) ? ENTITIES[name]! : Object.hasOwn(ENTITIES, name.toLowerCase()) ? ENTITIES[name.toLowerCase()]! : all;
            const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
            return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
        });
    return decoded.normalize("NFC").replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, "\"").replace(/[\s\u00a0\u202f]+/g, " ").trim();
}
/** 18/11 (SAV-93): a V2 case note whose proof may compare the normalized text (new rows carry `ticketAssociation`; older V2 summary rows are recognized by key). */
const normalizedCaseNote = (intent: EffectIntent) => intent.ticketAssociation === "at_create"
    || hiddenMarkerNoteKey(intent.key) || /^note-association:[^:]+:(?:reply|closed|handoff)-summary\./.test(intent.key);
const ownerHistorySchema = z.object({ propertiesWithHistory: z.object({ hubspot_owner_id: z.array(z.object({ value: z.string().nullable().optional(), timestamp: z.string() }).passthrough()).min(1) }).passthrough() }).passthrough();
const sameProperties = (actual: Record<string, string | null>, expected: Record<string, string>) => Object.entries(expected).every(([k, v]) => k === "hs_timestamp" ? Date.parse(actual[k] ?? "") === Date.parse(v) : actual[k] === v);
// HubSpot removes this exact historical comment and may append one LF. Do
// not strip arbitrary HTML or infer ownership from matching business text.
// 18/11 (SAV-93): `normalized` (a V2 case note anchored by its creation ACK) compares the text a person reads, not the bytes HubSpot stored.
function sameNoteProperties(actual: Record<string, string | null>, expected: Record<string, string>, allowRemovedMarker: boolean, normalized = false) {
    const body = expected.hs_note_body, timestamp = expected.hs_timestamp;
    if (!body || !timestamp || !Number.isFinite(Date.parse(timestamp)) || !Number.isFinite(Date.parse(actual.hs_timestamp ?? "")))
        return false;
    if (normalized && allowRemovedMarker)
        return typeof actual.hs_note_body === "string" && Boolean(noteBodyText(body)) && noteBodyText(actual.hs_note_body) === noteBodyText(body)
            && sameProperties({ ...actual, hs_note_body: body }, expected);
    const legacy = body.match(/^<p>(?:[^<>&"']|&(?:amp|lt|gt|quot|#39);|<br>)*<\/p>(<!-- sav-intake:[a-f0-9]{64} -->)$/);
    const stripped = allowRemovedMarker && legacy ? body.slice(0, -legacy[1].length) : null;
    const observed = actual.hs_note_body;
    return (observed === body || observed === `${body}\n` || stripped !== null && (observed === stripped || observed === `${stripped}\n`))
        && sameProperties({ ...actual, hs_note_body: body }, expected);
}
// Gmail headers are strings, and inbound bodyText intentionally strips signatures.
// Verify the single decoded MIME part byte-for-byte instead of that inbound view.
export function oneAddress(header: string) {
    const parts = header.split(",");
    if (parts.length !== 1)
        return null;
    const value = parts[0].trim().match(/^(?:[^<>]*<([^<>]+)>|([^<>\s]+@[^<>\s]+))$/);
    return (value?.[1] ?? value?.[2] ?? "").trim().toLowerCase() || null;
}
export function exactMimeText(payload: unknown): string | null {
    const p = z.object({
        mimeType: z.string(), filename: z.string().optional(), body: z.object({
            data: z.string().optional(), attachmentId: z.string().optional()
        }), parts: z.array(z.unknown()).optional()
    }).safeParse(payload);
    if (!p.success || p.data.mimeType !== "text/plain" || p.data.filename || p.data.parts?.length || p.data.body.attachmentId || p.data.body.data === undefined)
        return null;
    const bytes = Buffer.from(p.data.body.data, "base64url");
    const text = new TextDecoder("utf-8", {
        fatal: true
    }).decode(bytes);
    return text;
}
export type GmailRequest = <T>(mailbox: string, path: string, init?: RequestInit) => Promise<T>;
export function createIntakeExecutorAdapters(options: {
    network?: typeof fetch;
    gmailRequest?: GmailRequest;
    gmailPermissions?: (mailbox: string, signal: AbortSignal) => Promise<void>;
    env?: () => Record<string, string | undefined>;
} = {}): ExecutorAdapters {
    const network = options.network ?? fetch, env = options.env ?? (() => process.env), gmail = options.gmailRequest ?? requestSavGmail;
    const authNetwork: typeof fetch = (url, init) => network(url, {
        ...init, redirect: "error", headers: {
            ...Object.fromEntries(new Headers(init?.headers)), Authorization: `Bearer ${env().HUBSPOT_ACCESS_TOKEN ?? ""}`
        }
    });
    const transport = createSavHubspotTransport(authNetwork);
    const hub = <T>(path: string, method: string, signal: AbortSignal, body?: unknown) => transport<T>(path, {
        method, signal, headers: {
            "Content-Type": "application/json", Accept: "application/json"
        }, ...(body ? {
            body: JSON.stringify(body)
        } : {})
    }, status => `HUBSPOT_HTTP_${status}`);
    const read = (type: "tickets" | "notes" | "emails", objectId: string, signal: AbortSignal) => hub<unknown>(`/crm/v3/objects/${type}/${id(objectId)}?properties=${type === "tickets" ? "subject,content,hs_pipeline,hs_pipeline_stage,hubspot_owner_id,createdate,source_type,hs_ticket_category" : type === "notes" ? "hs_note_body,hs_timestamp" : "hs_email_subject,hs_email_text,hs_email_headers,hs_timestamp,hs_email_direction,hs_email_from_email,hs_email_to_email"}`, "GET", signal).then(object);
    /** Review F3: the ticket's owner history, read only. Its earliest entry, alone at that time, must be `ownerId`, set within
     * 5 s of `createdate`. A missing, malformed, truncated or ambiguous history proves nothing. */
    async function createdWithOwner(ticketId: string, ownerId: string, createdate: string, signal: AbortSignal) {
        const parsed = ownerHistorySchema.safeParse(await hub<unknown>(`/crm/v3/objects/tickets/${id(ticketId)}?propertiesWithHistory=hubspot_owner_id`, "GET", signal));
        const created = Date.parse(createdate);
        if (!parsed.success || !Number.isFinite(created)) return false;
        const entries = parsed.data.propertiesWithHistory.hubspot_owner_id.map(entry => ({ value: entry.value ?? "", at: Date.parse(entry.timestamp) }));
        if (entries.some(entry => !Number.isFinite(entry.at))) return false;
        const earliest = Math.min(...entries.map(entry => entry.at)), first = entries.filter(entry => entry.at === earliest);
        return first.length === 1 && first[0]!.value === ownerId && Math.abs(earliest - created) <= 5000;
    }
    async function association(type: string, objectId: string, to: string, target: string, signal: AbortSignal) {
        let after: string | undefined;
        const seen = new Set<string>();
        for (let n = 0; n < 5; n++) {
            const query = new URLSearchParams({
                limit: "100", ...(after ? {
                    after
                } : {})
            });
            const page = z.object({
                results: z.array(z.object({
                    toObjectId: z.union([z.string(), z.number()])
                })), paging: z.object({
                    next: z.object({
                        after: z.union([z.string(), z.number()])
                    })
                }).optional()
            }).parse(await hub(`/crm/v4/objects/${type}/${id(objectId)}/associations/${to}?${query}`, "GET", signal));
            if (page.results.some(r => String(r.toObjectId) === target))
                return true;
            if (!page.paging?.next)
                return false;
            after = String(page.paging.next.after);
            if (seen.has(after))
                return false;
            seen.add(after);
        }
        return false;
    }
    async function sent(intent: EffectIntent, ack: EffectAck | null, dispatchedAt: Date, signal: AbortSignal) {
        if (!intent.mailbox || !intent.rfcMessageId || !intent.threadId || !intent.recipient || !intent.text || !intent.raw)
            return null;
        const rawHeaders = intent.raw.split("\r\n\r\n", 1)[0].split("\r\n");
        const expectedParent = rawHeaders.find(h => /^In-Reply-To: /i.test(h))?.slice(13).trim();
        const expectedReferences = rawHeaders.find(h => /^References: /i.test(h))?.slice(12).trim();
        if (!expectedParent || !expectedReferences || !Number.isFinite(dispatchedAt.getTime())
            || ack?.threadId && ack.threadId !== intent.threadId) return null;
        let ids = ack?.id ? [ack.id] : [];
        if (!ids.length) {
            const result = await gmail<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>(intent.mailbox,
                `messages?${new URLSearchParams({ q: `in:sent rfc822msgid:${intent.rfcMessageId}`, maxResults: "2" })}`, { signal });
            if (result.nextPageToken || (result.messages?.length ?? 0) > 1) return null;
            ids = (result.messages ?? []).map(m => m.id);
            if (!ids.length) {
                // A rewritten Message-ID can also lose its ACK. Read only this
                // original thread and require a unique, fully attributed send.
                const thread = await gmail<{ id: string; messages?: { id: string; labelIds?: string[] }[] }>(intent.mailbox,
                    `threads/${encodeURIComponent(intent.threadId)}?format=metadata`, { signal });
                if (thread.id !== intent.threadId || !thread.messages || thread.messages.length > 100) return null;
                ids = thread.messages.filter(m => m.labelIds?.includes("SENT")).map(m => m.id);
                if (ids.length > 20) return null;
            }
        }
        const matches: EffectAck[] = [];
        for (const candidate of ids) {
            const message = await gmail<Parameters<typeof parseGmailMessage>[1] & { labelIds?: string[] }>(intent.mailbox,
                `messages/${encodeURIComponent(candidate)}?format=full`, { signal });
            const parsed = parseGmailMessage(intent.mailbox, message);
            const sentAt = Number(message.internalDate);
            const headers = message.payload?.headers ?? [];
            const singletonHeaders = ["from", "to", "message-id", "in-reply-to", "references"];
            if (singletonHeaders.some(name => headers.filter(h => h.name?.toLowerCase() === name).length !== 1)
                || parsed.gmailMessageId !== candidate || !message.labelIds?.includes("SENT") || parsed.gmailThreadId !== intent.threadId
                || !Number.isFinite(sentAt) || sentAt < dispatchedAt.getTime() - 60_000 || sentAt > dispatchedAt.getTime() + 600_000
                || parsed.to.length !== 1 || oneAddress(headers.find(h => h.name?.toLowerCase() === "to")?.value ?? "") !== intent.recipient.toLowerCase()
                || oneAddress(parsed.from) !== intent.mailbox.toLowerCase()
                || parsed.headers["in-reply-to"] !== expectedParent || parsed.headers.references !== expectedReferences
                || !parsed.headers["message-id"] || exactMimeText(message.payload) !== intent.text
                || headers.some(h => ["cc", "bcc"].includes(h.name?.toLowerCase() ?? "") && Boolean(h.value?.trim()))) continue;
            // SAV-10: the verified Gmail send time (internalDate, already checked against the marker above) is kept in the receipt of a case reply, so that its J2 counts from the real mail.
            matches.push({ id: parsed.gmailMessageId, threadId: parsed.gmailThreadId, ...(intent.kind === "reply_send" ? { sentAt: new Date(sentAt).toISOString() } : {}) });
        }
        return matches.length === 1 ? matches[0] : null;
    }
    const adapters: ExecutorAdapters = {
        prepareTicketHistory: (contactId, signal) => collectTicketCreationHistory(id(contactId), (path, body) => hub(path, body === undefined ? "GET" : "POST", signal, body)),
        async v2OwnerAtCreation(input) {
            const current = env();
            if (current.SAV_CASE_RECORDING !== "on" || current.SAV_V2_ENTRY !== "on" || input.signal.aborted)
                return { assign: false, reason: "v2_off" };
            const { creationOwnerForIntake } = await import("../cases/v2-entry");
            return creationOwnerForIntake(current, input);
        },
        qualifyAddedEmails: (baseline,current,source,signal) => qualifyCrmHistoryAdditions(baseline,current,source,{authority:env().SAV_INTAKE_CRM_ACK_TEMPLATES_JSON,
          readEmail: objectId => read("emails",objectId,signal),
          verifyAckOrigin: async expected => {
            const list=await gmail<{messages?:{id:string;threadId:string}[];nextPageToken?:string}>(expected.mailbox,
              `messages?${new URLSearchParams({q:`in:sent rfc822msgid:${expected.rfcMessageId}`,maxResults:"2"})}`,{signal});
            if(list.nextPageToken||list.messages?.length!==1||list.messages[0].threadId!==expected.gmailThreadId)return false;
            const raw=await gmail<Parameters<typeof parseGmailMessage>[1]&{labelIds?:string[]}>(expected.mailbox,`messages/${encodeURIComponent(list.messages[0].id)}?format=full`,{signal});
            const headers=raw.payload?.headers??[], values=(name:string)=>headers.filter(h=>h.name?.toLowerCase()===name).map(h=>h.value);
            if(["from","to","message-id","in-reply-to","auto-submitted"].some(k=>values(k).length!==1)
              ||["cc","bcc"].some(k=>values(k).some(v=>v?.trim()))||values("references").length>1)return false;
            const at=Number(raw.internalDate);
            return raw.id===list.messages[0].id&&raw.threadId===expected.gmailThreadId&&Boolean(raw.labelIds?.includes("SENT"))
              &&values("message-id")[0]===expected.rfcMessageId&&values("in-reply-to")[0]===expected.parentId
              &&values("auto-submitted")[0]?.trim().toLowerCase()==="auto-replied"&&oneAddress(values("from")[0]??"")===expected.mailbox.toLowerCase()
              &&oneAddress(values("to")[0]??"")===expected.recipient.toLowerCase()&&values("subject").length===1&&values("subject")[0]===expected.subject
              &&exactMimeText(raw.payload)===expected.body&&Number.isFinite(at)&&Math.abs(at-Date.parse(expected.at))<=60_000&&at<=Date.now();
          }}),
        readCrm: (plan, input, config, signal) => collectExecutionCrm(plan, input, config, createSavIntakeHubspotReaders({
            network: authNetwork,
            onRead: trace => {
                if (trace.status !== "complete") {
                    const reason = trace.reason && /^[a-z0-9_]+$/i.test(trace.reason) ? trace.reason.toUpperCase() : "UNAVAILABLE";
                    throw Error(`SAV_INTAKE_EXECUTION_CRM_READ_${reason}`);
                }
            },
        }), signal), scope: executionScopeKeys,
        gmailPermissions: options.gmailPermissions ?? (async (mailbox) => {
            const p = await readSavGmailPermissions();
            if (!p.ok || p.mailboxEmail !== mailbox || p.sendScopeGranted !== true)
                throw Error("SAV_INTAKE_EXECUTION_GMAIL_PERMISSION_REQUIRED");
        }),
        gmailCurrent: async (mailbox, thread, gmailId, signal) => {
            const data = await gmail<{
                id: string;
                messages?: {
                    id: string;
                    labelIds?: string[];
                }[];
            }>(mailbox, `threads/${encodeURIComponent(thread)}?format=metadata`, {
                signal
            });
            const incoming = data.messages?.filter(m => !m.labelIds?.includes("SENT") && !m.labelIds?.includes("DRAFT"));
            if (data.id !== thread || incoming?.at(-1)?.id !== gmailId)
                throw Error("SAV_INTAKE_EXECUTION_GMAIL_CHANGED");
        },
        dispatch: async (intent, signal) => {
            // SAV-10: `reply_send` is the same in-thread Gmail send as `identity_send` (same fields, same verification); only its permission differs.
            if (intent.kind === "identity_send" || intent.kind === "reply_send") {
                if (!intent.mailbox || !intent.raw || !intent.threadId)
                    throw Error("SAV_INTAKE_EXECUTION_TEMPLATE_INVALID");
                return gmail<EffectAck>(intent.mailbox, "messages/send", {
                    method: "POST", signal, body: JSON.stringify({
                        raw: Buffer.from(intent.raw).toString("base64url"), threadId: intent.threadId
                    })
                });
            }
            let result: unknown;
            if (intent.kind === "ticket_create") {
                const history = ticketCreationHistorySchema.parse(intent.ticketHistory);
                if (history.contactId !== id(intent.contactId)) throw Error("SAV_TICKET_HISTORY_CONTACT_CHANGED");
                result = await hub("/crm/v3/objects/tickets", "POST", signal, {
                    properties: intent.properties, associations: ticketCreationAssociations(history)
                });
            }
            else if (intent.kind === "note_create")
                // 18/11 (SAV-93): a V2 case note is created ON its ticket, in this one call; an older row (no flag) keeps the separate association step.
                result = await hub("/crm/v3/objects/notes", "POST", signal, {
                    properties: intent.properties, ...(intent.ticketAssociation === "at_create" ? {
                        associations: [{ to: { id: id(intent.ticketId) }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: HUBSPOT_NOTE_TO_TICKET }] }]
                    } : {})
                });
            else if (intent.kind === "email_create" && intent.objectId)
                return {
                    id: id(intent.objectId)
                };
            else if (intent.kind === "email_create")
                result = await hub("/crm/v3/objects/emails", "POST", signal, {
                    properties: intent.properties
                });
            else if (intent.kind === "stage_new")
                result = await hub(`/crm/v3/objects/tickets/${id(intent.ticketId)}`, "PATCH", signal, {
                    properties: {
                        hs_pipeline_stage: SAV_HUBSPOT_SUPPORT.stages.new
                    }
                });
            else if (intent.kind === "owner_assign")
                // Refused before any call (review R1, 31/10): a re-read then a PATCH is not atomic and
                // HubSpot offers no conditional write, so a human set in between would be overwritten.
                // The executor no longer plans it; verify below stays read-only for any older effect.
                throw Error("SAV_INTAKE_EXECUTION_OWNER_UNGUARDED");
            else if (intent.kind === "note_associate" || intent.kind === "email_associate") {
                if (intent.kind === "email_associate" && intent.reuseExistingAssociation && await association("emails", id(intent.objectId), "tickets", id(intent.ticketId), signal))
                    return { id: intent.objectId };
                // 18/11 (SAV-93): a note created on its ticket needs no second write: the association is only re-read (a PUT only repairs one found missing).
                if (intent.kind === "note_associate" && intent.ticketAssociation === "at_create" && await association("notes", id(intent.objectId), "tickets", id(intent.ticketId), signal))
                    return { id: intent.objectId };
                await hub(`/crm/v4/objects/${intent.kind === "note_associate" ? "notes" : "emails"}/${id(intent.objectId)}/associations/default/tickets/${id(intent.ticketId)}`, "PUT", signal);
                return {
                    id: intent.objectId
                };
            }
            else
                throw Error("SAV_INTAKE_EXECUTION_MUTATION_FORBIDDEN");
            return {
                id: id(z.object({
                    id: z.string()
                }).parse(result).id)
            };
        },
        verify: async (intent, ack, dispatchedAt, signal) => {
            if (intent.kind === "identity_send" || intent.kind === "reply_send") {
                const a = await sent(intent, ack, dispatchedAt, signal);
                return {
                    confirmed: Boolean(a), attributed: Boolean(a), ...(a ? {
                        ack: a
                    } : {})
                };
            }
            if (intent.kind === "note_associate" || intent.kind === "email_associate") {
                const type = intent.kind === "note_associate" ? "notes" : "emails", row = await read(type, id(intent.objectId), signal);
                // The executor binds historical normalization to the confirmed
                // create effect, never to arbitrary association properties.
                const confirmedCreate = Boolean(intent.confirmedNoteCreate?.effectId && intent.confirmedNoteCreate.objectId === intent.objectId);
                const ok = row.id === intent.objectId && (type !== "notes" || !ack?.id || ack.id === intent.objectId) && (type === "notes"
                    ? sameNoteProperties(row.properties, intent.expectedProperties ?? {}, confirmedCreate, normalizedCaseNote(intent))
                    : sameProperties(row.properties, intent.expectedProperties ?? {})) && await association(type, id(intent.objectId), "tickets", id(intent.ticketId), signal);
                const p = row.properties, text = type === "notes" ? p.hs_note_body : JSON.stringify({
                    from: p.hs_email_from_email, to: p.hs_email_to_email, direction: p.hs_email_direction, subject: p.hs_email_subject, body: p.hs_email_text
                });
                if (!p.hs_timestamp || !text)
                    return {
                        confirmed: false, attributed: false
                    };
                return {
                    confirmed: ok, attributed: ok, ack: {
                        id: intent.objectId
                    }, observedHistory: {
                        id: `${type}:${row.id}`, kind: type === "notes" ? "note" : "email", at: new Date(p.hs_timestamp).toISOString(), text
                    }
                };
            }
            if (intent.kind === "owner_assign") {
                const row = await read("tickets", id(intent.ticketId), signal);
                const ok = row.id === intent.ticketId && Boolean(intent.properties?.hubspot_owner_id) && row.properties.hubspot_owner_id === intent.properties?.hubspot_owner_id;
                return {
                    confirmed: ok, attributed: ok && Boolean(ack?.id === intent.ticketId), ack: {
                        id: row.id
                    }
                };
            }
            if (intent.kind === "stage_new") {
                // Stage only: the owner is whatever the team set, never ours to check (Ugo, 27/10).
                const row = await read("tickets", id(intent.ticketId), signal);
                const ok = row.id === intent.ticketId && row.properties.hs_pipeline === SAV_HUBSPOT_SUPPORT.pipelineId && row.properties.hs_pipeline_stage === SAV_HUBSPOT_SUPPORT.stages.new;
                return {
                    confirmed: ok, attributed: ok && Boolean(ack?.id === intent.ticketId), ack: {
                        id: row.id
                    }
                };
            }
            const type = intent.kind === "ticket_create" ? "tickets" : intent.kind === "note_create" ? "notes" : "emails";
            let candidate = ack?.id;
            if (!candidate) {
                const property = type === "tickets" ? "content" : type === "notes" ? "hs_note_body" : "hs_email_text";
                const found = z.object({
                    results: z.array(z.object({
                        id: z.string()
                    })), paging: z.unknown().optional()
                }).parse(await hub(`/crm/v3/objects/${type}/search`, "POST", signal, {
                    filterGroups: [{
                            filters: [{
                                    propertyName: property, operator: "CONTAINS_TOKEN", value: intent.marker
                                }]
                        }], properties: Object.keys(intent.properties ?? {}), limit: 2
                }));
                if (found.paging || found.results.length !== 1)
                    return {
                        confirmed: false, attributed: false
                    };
                candidate = found.results[0].id;
            }
            const row = await read(type, id(candidate), signal);
            const noteBody = intent.properties?.hs_note_body;
            const validNoteIntent = intent.kind !== "note_create" || typeof intent.text === "string" && Boolean(intent.marker?.match(/^[a-f0-9]{64}$/))
                && (noteBody === renderIntakeNote(intent.text, intent.marker!) || noteBody === renderIntakeNoteHidden(intent.text, intent.marker!));
            // The owner a creation carried is proven apart (review F3): today's owner may be a person who took the ticket since.
            const createdOwner = type === "tickets" ? intent.properties?.hubspot_owner_id ?? null : null;
            const expected = createdOwner ? Object.fromEntries(Object.entries(intent.properties ?? {}).filter(([key]) => key !== "hubspot_owner_id")) : intent.properties ?? {};
            let ok = row.id === candidate && validNoteIntent && (type === "notes"
                ? sameNoteProperties(row.properties, intent.properties ?? {}, Boolean(ack?.id === candidate && ack.operatorCandidate !== true), normalizedCaseNote(intent))
                : sameProperties(row.properties, expected));
            if (!ack && !intent.objectId && (!intent.marker || !Object.values(row.properties).some(v => v?.includes(intent.marker!))))
                ok = false;
            // 18/11 (SAV-93): a note created on its ticket is proven WITH that association (read back), never as a note alone.
            if (type === "notes" && ok && intent.ticketAssociation === "at_create")
                ok = await association("notes", id(candidate), "tickets", id(intent.ticketId), signal);
            // Without a created owner: empty, as before. With one: the creation is proven by today's owner being it, or else by
            // HubSpot's history showing it was the ticket's FIRST owner, set at its creation (review F3). A person who took the
            // ticket since keeps it (nothing is written) and the relay then reads « a person »; an insufficient history stays uncertain.
            if (type === "tickets")
                ok = ok && Object.hasOwn(row.properties, "hubspot_owner_id") && (createdOwner ? true : !row.properties.hubspot_owner_id) && await association("tickets", id(candidate), "contacts", id(intent.contactId), signal) && Boolean(row.properties.createdate) && Date.parse(row.properties.createdate!) >= dispatchedAt.getTime() - 5000;
            if (type === "tickets" && ok && intent.ticketHistory)
                ok = intent.ticketHistory.contactId === intent.contactId && await verifyTicketCreationHistory(candidate, intent.ticketHistory,
                    (path, body) => hub(path, body === undefined ? "GET" : "POST", signal, body));
            if (type === "tickets" && ok && createdOwner && row.properties.hubspot_owner_id !== createdOwner)
                ok = await createdWithOwner(candidate, createdOwner, row.properties.createdate!, signal);
            return {
                confirmed: ok, attributed: ok, ack: {
                    id: candidate
                }, ...(type === "tickets" && ok ? {
                    observedTicket: {
                        id: row.id, contactIds: [id(intent.contactId)], stage: "new" as const, ownerId: createdOwner ? row.properties.hubspot_owner_id || null : null, subject: row.properties.subject!, content: row.properties.content!, createdAt: new Date(row.properties.createdate!).toISOString()
                    }
                } : {})
            };
        },
    };
    return adapters;
}
