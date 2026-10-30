import { z } from "zod";

/** Compact generation contract. References are short only on the wire: the
 * existing semantic validator still receives the exact canonical identifiers.
 * The snapshot hash binds the entire answer, including a resumed/second phase. */
export type SimpleWireReferences = {
  messageId: string;
  snapshot: string;
  sources: Record<string, string>;
  tickets: Record<string, string>;
  contacts: Record<string, string>;
};
const enumOf = (values: string[]) => values.length ? z.enum(values as [string, ...string[]]) : z.string().max(0);
const shortText = (maxBytes: number) => z.string().trim().min(1).max(maxBytes)
  .refine(s => Buffer.byteLength(s, "utf8") <= maxBytes, "Text exceeds UTF-8 byte budget");
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const aliases = (prefix: string, ids: string[]) => {
  if (!unique(ids)) throw Error("SAV_INTAKE_SIMPLE_REFERENCE_DUPLICATE");
  return Object.fromEntries(ids.map((id, index) => [`${prefix}${index}`, id]));
};

/** Diagnostics expose canonical semantic field names, not protocol spelling. */
export function simpleWireValidationError(error: z.ZodError): z.ZodError {
  const top: Record<string, string> = { v: "messageId", n: "nature", r: "requests", g: "registration", t: "ticketTitle", i: "identity", j: "tickets", x: "missing", w: "rationale" };
  const fields: Record<string, Record<string, string>> = { r: { k: "kind", s: "summary", e: "sourceIds" },
    g: { a: "address", q: "quote" }, i: { k: "kind", c: "contactIds", w: "why" }, j: { t: "ticketId", r: "relation", w: "why", e: "sourceIds" }, x: { k: "kind", w: "why" } };
  return new z.ZodError(error.issues.map(issue => {
    const group = String(issue.path[0]);
    return { ...issue, path: issue.path.map((part, index) => index === 0 ? top[String(part)] ?? part : typeof part === "string" ? fields[group]?.[part] ?? part : part) };
  }));
}

export function simpleWireReferences(snapshot: string, messageId: string, sourceIds: string[], ticketIds: string[], contactIds: string[]): SimpleWireReferences {
  return { snapshot, messageId, sources: aliases("s", sourceIds), tickets: aliases("t", ticketIds), contacts: aliases("c", contactIds) };
}

export function simpleWireContract(refs: SimpleWireReferences, canonical: z.ZodType, extras: Record<string, z.ZodType> = {}) {
  const sources = z.array(enumOf(Object.keys(refs.sources))).min(1).max(20).refine(unique, "Duplicate source reference");
  const base = z.object({
    v: z.enum([refs.snapshot]),
    n: z.enum(["request", "newsletter", "information", "indeterminate"]),
    r: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/),
      k: z.enum(["support", "finance", "cancellation", "partnership", "commercial", "investor", "other", "acknowledgement", "unknown"]),
      s: shortText(160), e: sources }).strict()).max(15),
    g: z.object({ a: z.email(), q: z.string().trim().min(1).max(500) }).strict().optional(),
    t: z.string().trim().min(1).max(120).optional(),
    i: z.object({ k: z.enum(["unique", "equivalent", "unknown"]),
      c: z.array(enumOf(Object.keys(refs.contacts))).max(Math.min(10, Object.keys(refs.contacts).length)).refine(unique, "Duplicate contact reference"), w: shortText(120) }).strict(),
    j: z.array(z.object({ t: enumOf(Object.keys(refs.tickets)), r: z.enum(["same", "different", "unclear"]),
      w: shortText(120), e: sources }).strict()).length(Object.keys(refs.tickets).length),
    x: z.array(z.object({ k: z.enum(["image", "history", "contact", "other"]), w: shortText(120) }).strict()).max(10),
    w: shortText(160),
  }).strict();
  const schema = base.extend(extras);
  type Wire = z.infer<typeof base> & Record<string, unknown>;
  const decode = (raw: unknown) => {
    const wire = schema.parse(raw) as Wire;
    const lookup = (map: Record<string, string>, key: string) => {
      if (!Object.hasOwn(map, key)) throw Error("SAV_INTAKE_SIMPLE_REFERENCE_UNKNOWN");
      return map[key];
    };
    const { v, n, r, g, t, i, j, x, w, ...rest } = wire;
    void v;
    const requests = r.map(row => ({ id: row.id, kind: row.k, summary: row.s, sourceIds: row.e.map(id => lookup(refs.sources, id)) }));
    // The description is already a fallback of the canonical reader. Reuse all
    // request summaries once instead of asking for a second, potentially 4K
    // retelling. This can change prose, never ticket choice or permissions.
    return canonical.parse({ ...rest, messageId: refs.messageId,
      nature: n, requests,
      ...(g ? { registration: { address: g.a, quote: g.q } } : {}),
      ...(t ? { ticketTitle: t } : {}),
      ...(requests.length ? { ticketDescription: requests.map(row => row.summary).join("\n") } : {}),
      identity: { kind: i.k, contactIds: i.c.map(id => lookup(refs.contacts, id)), why: i.w },
      tickets: j.map(row => ({ ticketId: lookup(refs.tickets, row.t), relation: row.r, why: row.w, sourceIds: row.e.map(id => lookup(refs.sources, id)) })),
      missing: x.map(row => ({ kind: row.k, why: row.w })), rationale: w });
  };
  return { schema, decode };
}
