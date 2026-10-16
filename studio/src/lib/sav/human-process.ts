import { z } from "zod";
import { savRequestNatureSchema } from "./understanding";
import { SAV_HUBSPOT_SUPPORT } from "./hubspot-mapping";
import { savTicketReturnPlan } from "./ticket-lifecycle";
import type { SavStructuredProposal } from "./proposal";
import type { SavDossierContext } from "./dossier-context";

export const savHumanActionLabels = {
  create_ticket: "Créer un nouveau ticket", link_ticket: "Rattacher à un ticket ouvert",
  reopen_ticket: "Traiter le retour sur un ticket fermé", partnership: "Transférer une demande de partenariat",
  commercial: "Demande commerciale · règle existante", no_ticket: "Aucun ticket nécessaire",
} as const;
const lines = z.array(z.string().trim().min(1).max(1000)).max(30);
export const savHumanProcessSchema = z.object({
  action: z.enum(["create_ticket", "link_ticket", "reopen_ticket", "partnership", "commercial", "no_ticket"]),
  ticketId: z.string().regex(/^\d{1,30}$/).nullable(), confirmed: z.boolean(), reason: z.string().trim().min(20).max(2000),
  understanding: z.object({
    primaryRequestId: z.string().min(1).max(100),
    requests: z.array(z.object({ id: z.string().min(1).max(100), summary: z.string().trim().min(3).max(600), nature: savRequestNatureSchema,
      product: z.string().max(200), feature: z.string().max(200) }).strict()).min(1).max(15),
    relationship: z.enum(["prospect", "existing_customer", "unknown"]),
    knownFacts: lines, attemptedSteps: lines, missingInformation: lines,
  }).strict(),
}).strict().superRefine((value, ctx) => {
  if (!value.confirmed || !value.understanding.requests.some(r => r.id === value.understanding.primaryRequestId)
    || new Set(value.understanding.requests.map(r => r.id)).size !== value.understanding.requests.length
    || ["link_ticket", "reopen_ticket"].includes(value.action) && !value.ticketId
    || !["link_ticket", "reopen_ticket"].includes(value.action) && value.ticketId) ctx.addIssue({ code: "custom", message: "SAV_HUMAN_PROCESS_CONFIRMATION_REQUIRED" });
});
export type SavHumanProcess = z.infer<typeof savHumanProcessSchema>;
export function savHumanTicketAction(p: SavStructuredProposal) {
  return p.humanProcess && ["create_ticket", "link_ticket", "reopen_ticket"].includes(p.humanProcess.action) ? p.humanProcess : null;
}
/** Callers supply a current approved review; CRM records are always read fresh. */
export function applySavHumanTicketRouting(p: SavStructuredProposal, context: SavDossierContext, returnedAt: Date | string): SavDossierContext {
  const choice = savHumanTicketAction(p);
  if (!choice) return context;
  savHumanProcessSchema.parse(choice);
  const crm = context.crm.data;
  if (context.crm.status !== "ready" || !crm?.contactId) throw new Error("SAV_HUBSPOT_CONTACT_REQUIRED");
  if (choice.action === "create_ticket") return { ...context, crm: { ...context.crm, data: { ...crm, routing: { kind: "new", reason: "human_confirmed_distinct_issue", candidateIds: [] } } } };
  const target = crm.tickets.find(ticket => ticket.id === choice.ticketId && ticket.pipelineId === SAV_HUBSPOT_SUPPORT.pipelineId);
  if (!target || (choice.action === "link_ticket" ? target.status !== "open" : target.status !== "closed")) throw new Error("SAV_LINK_TARGET_INVALID");
  return { ...context, crm: { ...context.crm, data: { ...crm, routing: { kind: "matched", ticketId: target.id, reason: "human_confirmed_same_issue", returnOperation: savTicketReturnPlan(target, returnedAt).operation } } } };
}
export function savEffectiveCustomerEmail(p: SavStructuredProposal, identity: { kind: string; email: string | null }) {
  return identity.kind === "forwarded" ? identity.email : p.customerIdentity.verifiedByHuman && p.customerIdentity.registrationEmail ? p.customerIdentity.registrationEmail : identity.email;
}
export function savSuggestedTicketTitle(p: SavStructuredProposal) {
  const existing=p.ticket.title.trim().split(/\s+/);
  if (p.humanProcess && existing.length>=4 && existing.length<=6 && !/^(?:(?:re|fw|fwd|tr)\s*:\s*)+$/i.test(p.ticket.title.trim())) return p.ticket.title;
  const u=p.humanProcess?.understanding ?? p.understanding;
  const primary=u?.requests.find(r=>r.id===u.primaryRequestId);
  const words=(primary?.summary || p.ticket.title).replace(/^(?:le client|la cliente)\s+(?:demande|souhaite)\s+/i,"").replace(/^(?:(?:re|fw|fwd|tr)\s*:\s*)+/i,"").replace(/[^\p{L}\p{N}’' -]/gu," ").trim().split(/\s+/).filter(Boolean);
  return !words.length ? "Demande de support à qualifier" : words.length>=4 ? words.slice(0,6).join(" ") : ["Demande","support","concernant",...words].slice(0,6).join(" ");
}
