import "server-only";
import { z } from "zod";
import { createSavHubspotTransport } from "../hubspot-transport";
import { createSavIntakeHubspotReaders } from "./hubspot-readers";
import { requestSavGmail, parseGmailMessage } from "../gmail";
import { readSavGmailPermissions } from "../gmail-permissions";
import { collectExecutionCrm, executionScopeKeys } from "./execution-context";
import type { ExecutorAdapters, EffectAck, EffectIntent } from "./execution-types";
const id = (s: string | undefined) => z.string().regex(/^\d{1,30}$/).parse(s);
const object = (v: unknown) => z.object({
    id: z.string(), properties: z.record(z.string(), z.string().nullable())
}).parse(v);
const plain = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
export const renderIntakeNote = (text: string, marker: string) => `<p>${plain(text).replace(/\n/g, "<br>")}</p><p>[Studio intake: ${plain(marker)}]</p>`;
const sameProperties = (actual: Record<string, string | null>, expected: Record<string, string>) => Object.entries(expected).every(([k, v]) => k === "hs_timestamp" ? Date.parse(actual[k] ?? "") === Date.parse(v) : actual[k] === v);
// HubSpot removes this exact historical comment and may append one LF. Do
// not strip arbitrary HTML or infer ownership from matching business text.
function sameNoteProperties(actual: Record<string, string | null>, expected: Record<string, string>, allowRemovedMarker: boolean) {
    const body = expected.hs_note_body, timestamp = expected.hs_timestamp;
    if (!body || !timestamp || !Number.isFinite(Date.parse(timestamp)) || !Number.isFinite(Date.parse(actual.hs_timestamp ?? "")))
        return false;
    const legacy = body.match(/^<p>(?:[^<>&"']|&(?:amp|lt|gt|quot|#39);|<br>)*<\/p>(<!-- sav-intake:[a-f0-9]{64} -->)$/);
    const stripped = allowRemovedMarker && legacy ? body.slice(0, -legacy[1].length) : null;
    const observed = actual.hs_note_body;
    return (observed === body || observed === `${body}\n` || stripped !== null && (observed === stripped || observed === `${stripped}\n`))
        && sameProperties({ ...actual, hs_note_body: body }, expected);
}
// Gmail headers are strings, and inbound bodyText intentionally strips signatures.
// Verify the single decoded MIME part byte-for-byte instead of that inbound view.
function oneAddress(header: string) {
    const parts = header.split(",");
    if (parts.length !== 1)
        return null;
    const value = parts[0].trim().match(/^(?:[^<>]*<([^<>]+)>|([^<>\s]+@[^<>\s]+))$/);
    return (value?.[1] ?? value?.[2] ?? "").trim().toLowerCase() || null;
}
function exactMimeText(payload: unknown): string | null {
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
            matches.push({ id: parsed.gmailMessageId, threadId: parsed.gmailThreadId });
        }
        return matches.length === 1 ? matches[0] : null;
    }
    const adapters: ExecutorAdapters = {
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
            if (intent.kind === "identity_send") {
                if (!intent.mailbox || !intent.raw || !intent.threadId)
                    throw Error("SAV_INTAKE_EXECUTION_TEMPLATE_INVALID");
                return gmail<EffectAck>(intent.mailbox, "messages/send", {
                    method: "POST", signal, body: JSON.stringify({
                        raw: Buffer.from(intent.raw).toString("base64url"), threadId: intent.threadId
                    })
                });
            }
            let result: unknown;
            if (intent.kind === "ticket_create")
                result = await hub("/crm/v3/objects/tickets", "POST", signal, {
                    properties: intent.properties, associations: [{
                            to: {
                                id: id(intent.contactId)
                            }, types: [{
                                    associationCategory: "HUBSPOT_DEFINED", associationTypeId: 16
                                }]
                        }]
                });
            else if (intent.kind === "note_create")
                result = await hub("/crm/v3/objects/notes", "POST", signal, {
                    properties: intent.properties
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
                        hs_pipeline_stage: "1"
                    }
                });
            else if (intent.kind === "note_associate" || intent.kind === "email_associate") {
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
            if (intent.kind === "identity_send") {
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
                    ? sameNoteProperties(row.properties, intent.expectedProperties ?? {}, confirmedCreate)
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
            if (intent.kind === "stage_new") {
                const row = await read("tickets", id(intent.ticketId), signal), known = Object.hasOwn(row.properties, "hubspot_owner_id"), owner = row.properties.hubspot_owner_id || null;
                const ok = row.id === intent.ticketId && row.properties.hs_pipeline === "0" && row.properties.hs_pipeline_stage === "1" && known && owner === intent.expectedOwnerId;
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
                && (noteBody === renderIntakeNote(intent.text, intent.marker!) || noteBody === `<p>${plain(intent.text).replace(/\n/g, "<br>")}</p><!-- sav-intake:${intent.marker} -->`);
            let ok = row.id === candidate && validNoteIntent && (type === "notes"
                ? sameNoteProperties(row.properties, intent.properties ?? {}, Boolean(ack?.id === candidate && ack.operatorCandidate !== true))
                : sameProperties(row.properties, intent.properties ?? {}));
            if (!ack && !intent.objectId && (!intent.marker || !Object.values(row.properties).some(v => v?.includes(intent.marker!))))
                ok = false;
            if (type === "tickets")
                ok = ok && Object.hasOwn(row.properties, "hubspot_owner_id") && !row.properties.hubspot_owner_id && await association("tickets", id(candidate), "contacts", id(intent.contactId), signal) && Boolean(row.properties.createdate) && Date.parse(row.properties.createdate!) >= dispatchedAt.getTime() - 5000;
            return {
                confirmed: ok, attributed: ok, ack: {
                    id: candidate
                }, ...(type === "tickets" && ok ? {
                    observedTicket: {
                        id: row.id, contactIds: [id(intent.contactId)], stage: "new" as const, ownerId: null, subject: row.properties.subject!, content: row.properties.content!, createdAt: new Date(row.properties.createdate!).toISOString()
                    }
                } : {})
            };
        },
    };
    return adapters;
}
