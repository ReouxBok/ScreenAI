/** Test-only adapter: existing semantic examples remain canonical so their
 * expected business decisions are readable. Direct wire tests do not use this. */
import type { SimpleWireReferences } from "./simple-wire";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function encodeSimpleWireFixture(value: unknown, refs: SimpleWireReferences): unknown {
  const out = record(value);
  const ref = (kind: "sources" | "contacts" | "tickets", id: unknown) => Object.keys(refs[kind]).find(key => refs[kind][key] === id) ?? id;
  const list = (value: unknown, fn: (value: Record<string, unknown>) => unknown) => Array.isArray(value) ? value.map(v => fn(record(v))) : value;
  const references = (kind: "sources" | "contacts", value: unknown) => Array.isArray(value) ? value.map(id => ref(kind, id)) : value;
  return {
    v: out.messageId === refs.messageId ? refs.snapshot : "wrong-message",
    n: out.nature,
    r: list(out.requests, r => ({ id: r.id, k: r.kind, s: r.summary, e: references("sources", r.sourceIds) })),
    ...(out.registration ? { g: { a: record(out.registration).address, q: record(out.registration).quote } } : {}),
    ...(out.ticketTitle ? { t: out.ticketTitle } : {}),
    i: { k: record(out.identity).kind, c: references("contacts", record(out.identity).contactIds), w: record(out.identity).why },
    j: list(out.tickets, t => ({ t: ref("tickets", t.ticketId), r: t.relation, w: t.why, e: references("sources", t.sourceIds) })),
    x: list(out.missing, m => ({ k: m.kind, w: m.why })),
    w: out.rationale,
    ...Object.fromEntries(["images", "imageRequirements", "unreadAttachmentRequirements"].filter(key => Object.hasOwn(out, key)).map(key => [key, out[key]])),
  };
}
