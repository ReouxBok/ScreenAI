import { createHash } from "node:crypto";
import { z } from "zod";
import { savEvidenceContains } from "../evidence-text";

/** No raw provider value or client text belongs in diagnostic messages. These
 * bounded facts travel only with the existing private evaluation trace. */
export type IntakeEvidenceFailure = {
  reason: "unknown_anchor" | "wrong_anchor_source" | "ambiguous_quote_format" | "unknown_source" | "excerpt_not_in_source" | "required_source_missing" | "message_id_mismatch" | "registration_source_invalid" | "output_schema_invalid" | "visual_structure_invalid";
  path: string;
  issues?: import("./schema-diagnostics").IntakeSchemaIssue[];
  excerptHash?: string;
  excerptLength?: number;
};
export class IntakeEvidenceError extends Error {
  constructor(readonly diagnostic: IntakeEvidenceFailure) {
    super("SAV_INTAKE_MODEL_CITATION_REJECTED");
  }
}
export function rejectIntakeEvidence(reason: IntakeEvidenceFailure["reason"], path: string, excerpt?: string): never {
  throw new IntakeEvidenceError({ reason, path,
    ...(excerpt === undefined ? {} : { excerptHash: createHash("sha256").update(excerpt).digest("hex"), excerptLength: excerpt.length }) });
}

/** An unproven optional registration declaration may be discarded (identity then
 * falls back to the sender) only when it carries no inherited continuation
 * request and the current authored text names no address other than the
 * sender's. An explicit alternative address keeps the strict citation check. */
export function intakeRegistrationDiscardable(currentText: string, senderEmail: string, inherited: boolean) {
  if (inherited) return false;
  const sender = senderEmail.trim().toLowerCase();
  const named = currentText.match(/[^\s<>()[\]"',;:]+@[^\s<>()[\]"',;:]+/g) ?? [];
  return named.every(address => address.toLowerCase().replace(/[.!?]+$/, "") === sender);
}

export type IntakeEvidenceAnchor = { id: string; sourceId: string; text: string };
type Anchor = IntakeEvidenceAnchor;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Split into contiguous verbatim spans, never a summary or fuzzy match. Full
 * source content is retained, apart from whitespace at span boundaries. A span
 * must still pass the unchanged production containment check. */
export function intakeEvidenceCatalogue(sources: ReadonlyMap<string, string>) {
  const entries: Anchor[] = [];
  for (const [sourceId, text] of sources) {
    let start = 0;
    while (start < text.length) {
      while (start < text.length && /\s/u.test(text[start])) start++;
      if (start === text.length) break;
      let end = Math.min(start + 1800, text.length);
      while (end < text.length && end > start && !/\s/u.test(text[end])) end--;
      // Never silently discard an unrepresentable token or partial source.
      if (end === start) throw Error("SAV_INTAKE_MODEL_CONTEXT_LIMIT");
      const excerpt = text.slice(start, end).trim();
      if (!savEvidenceContains(text, excerpt) || entries.length >= 256) throw Error("SAV_INTAKE_MODEL_CONTEXT_LIMIT");
      entries.push({ id: `q${entries.length + 1}`, sourceId, text: excerpt });
      start = end;
    }
  }
  if (!entries.length) throw Error("SAV_INTAKE_MODEL_CONTEXT_LIMIT");
  const byId = new Map(entries.map(e => [e.id, e]));
  const quoteIds = (sourceId?: string) => {
    const ids = entries.filter(e => sourceId === undefined || e.sourceId === sourceId).map(e => e.id);
    if (!ids.length) throw Error("SAV_INTAKE_MODEL_CONTEXT_LIMIT");
    return z.enum(ids as [string, ...string[]]);
  };
  const quoteIdsFor = (sourceIds: readonly string[], allowEmpty = false) => {
    const ids = entries.filter(e => sourceIds.includes(e.sourceId)).map(e => e.id);
    // Null is the only selection when all captured sources of this kind are empty.
    if (!ids.length && allowEmpty) return z.null();
    if (!ids.length) throw Error("SAV_INTAKE_MODEL_CONTEXT_LIMIT");
    return z.enum(ids as [string, ...string[]]);
  };
  /** Legacy verbatim outputs remain subject to all their original validators.
   * New quoteIds are exact, source-bound references, never inferred repairs. */
  const resolve = (value: unknown, path: string, expectedSource?: string): unknown => {
    if (!record(value) || !Object.hasOwn(value, "quoteId")) return value;
    if (Object.hasOwn(value, "quote")) rejectIntakeEvidence("ambiguous_quote_format", path);
    const anchor = typeof value.quoteId === "string" ? byId.get(value.quoteId) : undefined;
    if (!anchor) rejectIntakeEvidence("unknown_anchor", path);
    if (expectedSource !== undefined && anchor.sourceId !== expectedSource
      || Object.hasOwn(value, "sourceId") && value.sourceId !== anchor.sourceId) rejectIntakeEvidence("wrong_anchor_source", path);
    const { quoteId, ...rest } = value;
    void quoteId;
    return { ...rest, quote: anchor.text };
  };
  const grounding = (value: unknown, path: string) => {
    if (!Array.isArray(value) || value.length > 51) return value;
    return value.map((item, index) => {
      const resolved = resolve(item, `${path}.${index}`);
      if (!record(item) || !Object.hasOwn(item, "quoteId") || !record(resolved)) return resolved;
      return { ...resolved, sourceId: byId.get(String(item.quoteId))!.sourceId };
    });
  };
  return { entries, quoteIds, quoteIdsFor,
    decodeAnalysis(raw: unknown, messageId: string, initialMessageId?: string) {
      if (!record(raw)) return raw;
      const requests = Array.isArray(raw.requests) && raw.requests.length <= 15
        ? raw.requests.map((r, i) => {
          if (record(r) && r.originMessageId !== undefined && r.originMessageId !== initialMessageId)
            rejectIntakeEvidence("wrong_anchor_source", `requests.${i}.originMessageId`);
          return resolve(r, `requests.${i}.quote`, record(r) && r.originMessageId ? `message-${String(r.originMessageId)}` : "current");
        }) : raw.requests;
      let registration = raw.registration;
      if (record(registration)) registration = resolve(registration, "registration.quote",
        registration.sourceMessageId === messageId ? "current" : `message-${String(registration.sourceMessageId)}`);
      return { ...raw, requests, ...(registration === undefined ? {} : { registration }) };
    },
    decodeIssues(raw: unknown) {
      if (!record(raw) || !Array.isArray(raw.tickets) || raw.tickets.length > 20) return raw;
      return { ...raw, tickets: raw.tickets.map((t, i) => {
        if (!record(t)) return t;
        if (!record(t.grounding)) return { ...t, grounding: grounding(t.grounding, `tickets.${i}.grounding`) };
        const slots = t.grounding, path = `tickets.${i}.grounding`;
        if (Object.keys(slots).some(k => !["current", "ticket", "history", "initialRequest", "additional"].includes(k)))
          rejectIntakeEvidence("ambiguous_quote_format", path);
        const selected: unknown[] = [];
        for (const [key, source] of [["current", "current"], ["ticket", `ticket-${t.ticketId}`], ["history", `history-${t.ticketId}`], ["initialRequest", "initial-request"]]) {
          if (slots[key] === undefined || slots[key] === null) continue;
          const value = { quoteId: slots[key] };
          const resolved = resolve(value, `${path}.${key}`, source);
          selected.push({ ...(resolved as object), sourceId: source });
        }
        const extra = slots.additional;
        if (extra !== undefined && (!Array.isArray(extra) || extra.length > 47)) rejectIntakeEvidence("ambiguous_quote_format", path);
        for (const id of (extra ?? []) as unknown[]) selected.push({ quoteId: id });
        return { ...t, grounding: grounding(selected, path) };
      }) };
    },
    decodeIdentity(raw: unknown) { return record(raw) ? { ...raw, grounding: grounding(raw.grounding, "grounding") } : raw; },
  };
}
