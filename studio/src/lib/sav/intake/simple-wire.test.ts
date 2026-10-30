import { describe, expect, it } from "vitest";
import { z } from "zod";
import { simpleWireContract, simpleWireReferences } from "./simple-wire";
import { intakeResponseSchema } from "./model-readers";

const canonical = z.object({ messageId: z.string(), nature: z.string(), requests: z.array(z.object({ id: z.string(), kind: z.string(), summary: z.string(), sourceIds: z.array(z.string()) })),
  ticketTitle: z.string().optional(), ticketDescription: z.string().optional(), registration: z.object({ address: z.string(), quote: z.string() }).optional(),
  identity: z.object({ kind: z.string(), contactIds: z.array(z.string()), why: z.string() }),
  tickets: z.array(z.object({ ticketId: z.string(), relation: z.string(), why: z.string(), sourceIds: z.array(z.string()) })),
  missing: z.array(z.object({ kind: z.string(), why: z.string() })), rationale: z.string() }).strict();
const refs = simpleWireReferences("a".repeat(64), "message-long-uuid", ["current", "message-initial", "ticket-999999999999", "history-999999999999"], ["999999999999"], ["888888888888"]);
const answer = () => ({ v: refs.snapshot, n: "request", r: [{ id: "r1", k: "support", s: "Agenda en panne.", e: ["s0"] }], t: "Synchronisation agenda en panne",
  i: { k: "unique", c: ["c0"], w: "Adresse de l'expéditeur." }, j: [{ t: "t0", r: "same", w: "Même agenda.", e: ["s0", "s2", "s3"] }], x: [], w: "Demande identifiée." });

describe("compact snapshot-bound generation protocol", () => {
  it("decodes every reference into its original namespace before the canonical validator", () => {
    expect(simpleWireContract(refs, canonical).decode(answer())).toMatchObject({ messageId: "message-long-uuid", requests: [{ sourceIds: ["current"] }],
      identity: { contactIds: ["888888888888"] }, tickets: [{ ticketId: "999999999999", sourceIds: ["current", "ticket-999999999999", "history-999999999999"] }] });
  });
  it.each(["__proto__", "constructor", "ticket-999999999999", "c0", "s999"])("rejects unknown or cross-namespace source %s", ref => {
    const out = answer(); out.r[0].e = [ref];
    expect(() => simpleWireContract(refs, canonical).decode(out)).toThrow();
  });
  it.each(["s0", "c0", "999999999999", "__proto__"])("rejects a non-ticket reference %s", ref => {
    const out = answer(); out.j[0].t = ref;
    expect(() => simpleWireContract(refs, canonical).decode(out)).toThrow();
  });
  it("rejects a previous phase/snapshot even when its short aliases happen to be the same", () => {
    const next = simpleWireReferences("b".repeat(64), refs.messageId, Object.values(refs.sources), Object.values(refs.tickets), Object.values(refs.contacts));
    expect(() => simpleWireContract(next, canonical).decode(answer())).toThrow();
  });
  it("has exact snapshot and reference enums on the provider wire without nested array hints", () => {
    const schema = intakeResponseSchema(simpleWireContract(refs, canonical).schema) as { properties: Record<string, Record<string, unknown>> };
    expect(schema.properties.v.enum).toEqual([refs.snapshot]);
    expect(schema.properties).not.toHaveProperty("ticketDescription");
    expect(JSON.stringify(schema)).not.toMatch(/maxItems|minItems|maxLength/);
    expect(JSON.stringify(schema)).not.toContain("999999999999");
  });
  it("rejects duplicate aliases in the source catalog rather than silently losing their provenance", () => {
    expect(() => simpleWireReferences("scope", "message", ["current", "current"], [], [])).toThrow("SAV_INTAKE_SIMPLE_REFERENCE_DUPLICATE");
  });
  it("rejects duplicate source/contact references and extra top-level data", () => {
    const out = answer(); out.r[0].e.push("s0");
    expect(() => simpleWireContract(refs, canonical).decode(out)).toThrow();
    const other = answer(); other.i.c.push("c0");
    expect(() => simpleWireContract(refs, canonical).decode(other)).toThrow();
    expect(() => simpleWireContract(refs, canonical).decode({ ...answer(), privateField: "untrusted" })).toThrow();
  });
  it("requires the context's exact ticket cardinality; semantic coverage still rejects duplicate IDs later", () => {
    expect(() => simpleWireContract(refs, canonical).decode({ ...answer(), j: [] })).toThrow();
    expect(() => simpleWireContract(refs, canonical).decode({ ...answer(), j: [...answer().j, ...answer().j] })).toThrow();
  });
  it("rejects over-budget Unicode without truncating a request or buying an extra call", () => {
    const out = answer(); out.r[0].s = "é".repeat(81);
    expect(() => simpleWireContract(refs, canonical).decode(out)).toThrow();
    out.r[0].s = "é".repeat(80);
    expect((simpleWireContract(refs, canonical).decode(out) as z.infer<typeof canonical>).requests[0].summary).toBe(out.r[0].s);
  });
  it("reconstructs the description from all request summaries once, including the last request", () => {
    const out = answer(); out.r = Array.from({ length: 15 }, (_, i) => ({ id: `r${i}`, k: i === 14 ? "finance" : "support", s: `Demande ${i}.`, e: ["s0"] }));
    const decoded = simpleWireContract(refs, canonical).decode(out) as z.infer<typeof canonical>;
    expect(decoded.requests).toHaveLength(15); expect(decoded.requests[14].kind).toBe("finance");
    expect(decoded.ticketDescription).toBe(out.r.map(r => r.s).join("\n"));
    expect(decoded.ticketDescription).toContain("Demande 14.");
  });
  it("preserves registration and optional observation requirements through the exact extra schemas", () => {
    const extra = z.object({ sourceId: z.literal("file-1"), role: z.enum(["required", "unknown", "accessory"]), textQuote: z.string().optional() }).strict();
    const extended = canonical.extend({ unreadAttachmentRequirements: z.array(extra), images: z.array(z.object({ index: z.number(), text: z.string() })) });
    const out = { ...answer(), g: { a: "account@example.test", q: "Mon compte : account@example.test" }, unreadAttachmentRequirements: [{ sourceId: "file-1", role: "required", textQuote: "voir la pièce" }], images: [{ index: 0, text: "Observation complète" }] };
    const decoded = simpleWireContract(refs, extended, { unreadAttachmentRequirements: z.array(extra), images: extended.shape.images }).decode(out);
    expect(decoded).toMatchObject({ registration: { address: "account@example.test", quote: out.g.q }, unreadAttachmentRequirements: out.unreadAttachmentRequirements, images: out.images });
  });
  it("measures reduction on a maximum-cardinality ASCII fixture without claiming a global token bound", () => {
    const longId = (n: number) => "1".repeat(90) + `${n}`.padStart(10, "0");
    const tickets = Array.from({ length: 20 }, (_, i) => longId(i));
    const contacts = Array.from({ length: 10 }, (_, i) => longId(20 + i));
    const sources = ["current", ...tickets.flatMap(id => [`ticket-${id}`, `history-${id}`]), ...contacts.map(id => `contact-${id}`)];
    const refs = simpleWireReferences("s".repeat(64), longId(99), sources, tickets, contacts);
    const sourceRefs = Object.keys(refs.sources).slice(0, 20);
    const out = { v: refs.snapshot, n: "request", r: Array.from({ length: 15 }, (_, i) => ({ id: `r${i}`, k: "support", s: "x".repeat(160), e: sourceRefs })),
      t: "x".repeat(120), i: { k: "equivalent", c: Object.keys(refs.contacts), w: "x".repeat(120) },
      j: tickets.map((_, i) => ({ t: `t${i}`, r: "unclear", w: "x".repeat(120), e: sourceRefs })),
      x: Array.from({ length: 10 }, () => ({ k: "history", w: "x".repeat(120) })), w: "x".repeat(160) };
    const decoded = simpleWireContract(refs, canonical).decode(out) as z.infer<typeof canonical>;
    expect(decoded.requests).toHaveLength(15); expect(decoded.tickets).toHaveLength(20); expect(decoded.missing).toHaveLength(10);
    const bytes = Buffer.byteLength(JSON.stringify(out), "utf8");
    const old = { ...decoded, requests: decoded.requests.map(row => ({ ...row, summary: "x".repeat(300) })),
      tickets: decoded.tickets.map(row => ({ ...row, why: "x".repeat(500) })), ticketDescription: "x".repeat(4000), rationale: "x".repeat(500) };
    expect(bytes).toBeLessThan(13_500);
    expect(bytes).toBeLessThan(Buffer.byteLength(JSON.stringify(old), "utf8") / 5);
    // Byte size is an observable encoding bound, not a provider token count or
    // a proof that a model follows the concise instructions within 18/37 s.
  });
});
