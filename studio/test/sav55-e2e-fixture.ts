import { SAV53_E2E_KEY, sav53Proposal } from "./sav53-e2e-fixture";

/** Only synthetic fixtures. Reuses the approved SAV-53 display contract. */
export const SAV55_E2E_KEY = SAV53_E2E_KEY;
export const SAV55_THREADS = {
  unopened: "00000055-0000-4000-8000-000000000001",
  unreadReturn: "00000055-0000-4000-8000-000000000002",
  review: "00000055-0000-4000-8000-000000000003",
  ticketPending: "00000055-0000-4000-8000-000000000004",
  qualification: "00000055-0000-4000-8000-000000000005",
  candidate: "00000055-0000-4000-8000-000000000006",
  noTicket: "00000055-0000-4000-8000-000000000007",
  ticketConfirmed: "00000055-0000-4000-8000-000000000008",
} as const;
export const SAV55_SUBJECTS = {
  unopened: "SAV55 — Une demande à ouvrir", unreadReturn: "SAV55 — Nouveau message sur un ancien dossier",
  review: "SAV55 — Une demande à valider", ticketPending: "SAV55 — Action ticket en attente",
  qualification: "SAV55 — Bilan à qualifier", candidate: "SAV55 — Connaissance à examiner",
  noTicket: "SAV55 — Aucun ticket nécessaire", ticketConfirmed: "SAV55 — Ticket confirmé, suivi terminé",
} as const;
export function sav55Proposal(kind: keyof typeof SAV55_THREADS) {
  const p = sav53Proposal();
  p.ticket.title = SAV55_SUBJECTS[kind];
  p.ticket.description = "Demande de recette fictive, sans donnée client ni procédure réelle.";
  if (p.understanding) {
    p.understanding.requests[0].summary = SAV55_SUBJECTS[kind];
    p.understanding.requests[0].product = null; p.understanding.requests[0].feature = null;
  }
  if (kind === "noTicket" || kind === "candidate") p.decision.kind = "no_ticket_needed";
  return p;
}
