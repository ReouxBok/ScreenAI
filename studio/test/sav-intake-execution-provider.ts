import type { IntakeTicket, IntakeHistory } from "../src/lib/sav/intake/engine-types";
import type { GmailRequest } from "../src/lib/sav/intake/execution-adapters";
/** No sockets: every accepted provider request is explicitly implemented here. */
export function executionProvider(sender = "customer@example.invalid") {
    let sequence = 900;
    const objects: Record<string, Record<string, {
        id: string;
        properties: Record<string, string | null>;
    }>> = {
        tickets: {}, notes: {}, emails: {}
    };
    const links = new Map<string, string[]>(), calls: {
        path: string;
        method: string;
        body: unknown;
    }[] = [], sent: Record<string, unknown> = {};
    let contacts = [{
            id: "101", emails: [sender]
        }];
    let gmailIncoming = "incoming", gmailThread = "gmail-thread";
    const network: typeof fetch = async (url, init) => {
        const u = new URL(String(url)), path = u.pathname, method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({
            path, method, body
        });
        if (u.origin !== "https://api.hubapi.com")
            throw Error("EXTERNAL_NETWORK_FORBIDDEN");
        if (path === "/crm/v3/objects/contacts/search")
            return Response.json({
                total: contacts.length, results: contacts.map(c => ({
                    id: c.id, properties: {
                        email: c.emails[0], hs_additional_emails: c.emails.slice(1).join(";")
                    }
                }))
            });
        const contact = path.match(/^\/crm\/v3\/objects\/contacts\/(\d+)$/);
        if (contact) {
            const c = contacts.find(c => c.id === contact[1]);
            if (!c)
                throw Error("FAKE_CONTACT_MISSING");
            return Response.json({
                id: c.id, properties: {
                    email: c.emails[0], hs_additional_emails: c.emails.slice(1).join(";")
                }
            });
        }
        if (path === "/crm/v3/pipelines/tickets/0")
            return Response.json({
                id: "0", stages: [{
                        id: "1", metadata: {
                            isClosed: "false"
                        }
                    }, {
                        id: "2", metadata: {
                            isClosed: "false"
                        }
                    }, {
                        id: "3", metadata: {
                            isClosed: "false"
                        }
                    }, {
                        id: "4", metadata: {
                            isClosed: "true"
                        }
                    }]
            });
        const assoc = path.match(/^\/crm\/v4\/objects\/(contacts|tickets|notes|emails)\/(\d+)\/associations\/(?:default\/)?(contacts|tickets|notes|emails)(?:\/(\d+))?$/);
        if (assoc) {
            const [, type, id, to, target] = assoc, key = `${type}:${id}:${to}`;
            if (method === "PUT") {
                const values = links.get(key) ?? [];
                if (!values.includes(target))
                    values.push(target);
                links.set(key, values);
                const reverse = `${to}:${target}:${type}`;
                links.set(reverse, [...new Set([...(links.get(reverse) ?? []), id])]);
                return new Response(null, {
                    status: 204
                });
            }
            return Response.json({
                results: (links.get(key) ?? []).map(id => ({
                    toObjectId: id, associationTypes: [{
                            category: "HUBSPOT_DEFINED", typeId: 449
                        }]
                }))
            });
        }
        const collection = path.match(/^\/crm\/v3\/objects\/(tickets|notes|emails)(?:\/(batch\/read|search|\d+))?$/);
        if (collection) {
            const [, type, tail] = collection, rows = objects[type];
            if (method === "POST" && !tail) {
                const id = String(++sequence), properties = {
                    ...body.properties
                };
                if (type === "tickets") {
                    properties.createdate = new Date().toISOString();
                    properties.hubspot_owner_id = null;
                    const cid = body.associations[0].to.id;
                    links.set(`tickets:${id}:contacts`, [cid]);
                    links.set(`contacts:${cid}:tickets`, [...(links.get(`contacts:${cid}:tickets`) ?? []), id]);
                }
                if (type === "emails") {
                    const headers = JSON.parse(properties.hs_email_headers);
                    properties.hs_email_from_email = headers.from.email;
                    properties.hs_email_to_email = headers.to.map((r: {
                        email: string;
                    }) => r.email).join(";");
                }
                rows[id] = {
                    id, properties
                };
                return Response.json({
                    id
                });
            }
            if (method === "PATCH") {
                Object.assign(rows[tail].properties, body.properties);
                return Response.json({
                    id: tail
                });
            }
            const select = (row: {
                id: string;
                properties: Record<string, string | null>;
            }, fields: string[]) => ({
                id: row.id, properties: Object.fromEntries(fields.filter(k => Object.hasOwn(row.properties, k)).map(k => [k, row.properties[k]]))
            });
            if (tail === "batch/read")
                return Response.json({
                    status: "COMPLETE", results: body.inputs.map((i: {
                        id: string;
                    }) => select(rows[i.id], body.properties))
                });
            if (tail === "search") {
                const marker = body.filterGroups[0].filters[0].value;
                return Response.json({
                    results: Object.values(rows).filter(r => Object.values(r.properties).some(v => v?.includes(marker))).map(r => select(r, body.properties))
                });
            }
            if (method === "GET") {
                if (!rows[tail])
                    throw Error("FAKE_OBJECT_MISSING");
                return Response.json(select(rows[tail], (u.searchParams.get("properties") ?? "").split(",")));
            }
        }
        throw Error(`UNEXPECTED_FAKE_HUBSPOT_REQUEST:${method}:${path}`);
    };
    const gmail: GmailRequest = async <T>(_mailbox: string, path: string, init?: RequestInit) => {
        calls.push({
            path: `gmail/${path}`, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined
        });
        if (path.startsWith("threads/"))
            return {
                id: gmailThread, messages: [{
                        id: gmailIncoming, labelIds: ["INBOX"]
                    }]
            } as T;
        if (path === "messages/send") {
            const body = JSON.parse(String(init?.body)), raw = Buffer.from(body.raw, "base64url").toString("utf8"), [headers, ...rest] = raw.split("\r\n\r\n");
            const entries = headers.split("\r\n").map(h => ({
                name: h.slice(0, h.indexOf(":")), value: h.slice(h.indexOf(":") + 1).trim()
            }));
            const id = `sent-${++sequence}`;
            sent[id] = {
                id, threadId: body.threadId, internalDate: String(Date.now()), labelIds: ["SENT"], payload: {
                    mimeType: "text/plain", headers: entries, body: {
                        data: Buffer.from(rest.join("\r\n\r\n"), "base64").toString("base64url")
                    }
                }
            };
            return {
                id, threadId: body.threadId
            } as T;
        }
        if (path.startsWith("messages?"))
            return {
                messages: Object.keys(sent).map(id => ({
                    id, threadId: gmailThread
                }))
            } as T;
        const id = path.match(/^messages\/([^?]+)/)?.[1];
        if (id && sent[id])
            return sent[id] as T;
        throw Error("UNEXPECTED_FAKE_GMAIL_REQUEST");
    };
    function seedTicket(t: Partial<IntakeTicket> = {}) {
        const id = t.id ?? "201", properties = {
            subject: t.subject ?? "Synthetic connection failure", content: t.content ?? "Synthetic full request", hs_pipeline: "0", hs_pipeline_stage: t.stage === "closed" ? "4" : t.stage === "new" ? "1" : "2", hubspot_owner_id: t.ownerId === undefined ? null : t.ownerId, createdate: t.createdAt ?? new Date(Date.now() - 86400000).toISOString(), ...(t.closedAt ? {
                hs_last_closed_date: t.closedAt
            } : {})
        };
        objects.tickets[id] = {
            id, properties
        };
        links.set(`tickets:${id}:contacts`, t.contactIds ?? ["101"]);
        for (const cid of t.contactIds ?? ["101"])
            links.set(`contacts:${cid}:tickets`, [id]);
        return id;
    }
    return {
        network, gmail, calls, objects, links, sent, seedTicket, setContacts: (v: typeof contacts) => { contacts = v; }, setGmail: (id: string, thread: string) => { gmailIncoming = id; gmailThread = thread; }, histories: [] as IntakeHistory
    };
}
