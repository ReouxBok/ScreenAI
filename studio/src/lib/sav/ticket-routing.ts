export type SavTicketCandidate = { id: string; subject: string; status: "open" | "closed"; updatedAt?: string | null };

export function normalizeTicketSubject(value: string) {
  return value.toLocaleLowerCase("fr").replace(/^(?:(?:re|fw|fwd|tr)\s*:\s*)+/i, "").replace(/\[#?\d+\]/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function similarity(left: string, right: string) {
  const a = new Set(normalizeTicketSubject(left).split(" ").filter((word) => word.length > 2));
  const b = new Set(normalizeTicketSubject(right).split(" ").filter((word) => word.length > 2));
  if (!a.size || !b.size) return 0;
  const overlap = [...a].filter((word) => b.has(word)).length;
  return overlap / new Set([...a, ...b]).size;
}

export function selectSavTicketMatch(input: { subject: string; candidates: SavTicketCandidate[]; currentTicketId?: string | null }) {
  const open = input.candidates.filter((ticket) => ticket.status === "open");
  if (input.currentTicketId) {
    const linked = open.find((ticket) => ticket.id === input.currentTicketId);
    if (linked) return { kind: "matched" as const, ticket: linked, reason: "gmail_thread_link" };
  }
  const explicitId = input.subject.match(/(?:ticket|dossier|#)\s*#?(\d{2,})/i)?.[1];
  if (explicitId) {
    const explicit = open.find((ticket) => ticket.id === explicitId);
    if (explicit) return { kind: "matched" as const, ticket: explicit, reason: "explicit_ticket_reference" };
  }
  const normalized = normalizeTicketSubject(input.subject);
  const exact = open.filter((ticket) => normalizeTicketSubject(ticket.subject) === normalized);
  if (exact.length === 1) return { kind: "matched" as const, ticket: exact[0], reason: "exact_subject" };
  if (exact.length > 1) return { kind: "ambiguous" as const, candidates: exact, reason: "multiple_exact_subjects" };
  const ranked = open.map((ticket) => ({ ticket, score: similarity(input.subject, ticket.subject) }))
    .filter((item) => item.score >= 0.7).sort((a, b) => b.score - a.score);
  if (ranked.length === 1 || (ranked[0] && ranked[0].score - (ranked[1]?.score ?? 0) >= 0.2)) {
    return { kind: "matched" as const, ticket: ranked[0]!.ticket, reason: "strong_subject_similarity" };
  }
  if (ranked.length > 1) return { kind: "ambiguous" as const, candidates: ranked.map((item) => item.ticket), reason: "multiple_similar_subjects" };
  return { kind: "new" as const, reason: open.length ? "no_reliable_match" : "no_open_ticket" };
}
