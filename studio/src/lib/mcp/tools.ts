import "server-only";
import { z } from "zod";
import type { SavClerkUser } from "@/lib/sav/intake/console-auth";
import { listIntakeConsole } from "@/lib/sav/intake/console-store";
import { readIntakeConsoleDetail } from "@/lib/sav/intake/console-detail";
import { readIntakeRunDiagnostics } from "@/lib/sav/intake/run-diagnostics";
import { intakeBudgetOwnerFor, readIntakeBudgetPanel } from "@/lib/sav/intake/budget-admin";
import { savIntakeViewLabels, savIntakeViewSchema } from "@/lib/sav/intake/contract";
import { intakeStatusLabel, intakeReasonLabel, intakeBlockedCauseLabel, intakeRetryLabel } from "@/lib/sav/intake/console-presentation";
import { readOperatorPanel } from "@/lib/sav/intake-ux/operator-commands";
import { readManualOtherBinding } from "@/lib/sav/intake/manual-other-classification";
import { intakeDossierView, intakeDossierActions, intakeEffectLabels, intakeEffectStateLabels, intakeRouteLabel, intakeEffectsTitle, type IntakeConsoleDetail } from "@/lib/sav/intake/dossier-view";

/** Uniform tool result. A refusal is an answer, not a transport error. */
/** uncertain: a write may have been applied but its result is not established; the agent re-reads, never retries blindly. */
export type StudioMcpResult = { outcome: "done" | "already_done" | "refused" | "uncertain"; code: string; message: string; data?: unknown };
type Staff = { id: string; email: string; role: string; name: string | null };
export type StudioMcpContext = { user: NonNullable<SavClerkUser>; staff: Staff };
export type StudioMcpTool = { name: string; title: string; description: string; write: boolean; input: z.ZodObject;
  run(context: StudioMcpContext, input: never): Promise<StudioMcpResult> };

const done = (data: unknown, message = "OK"): StudioMcpResult => ({ outcome: "done", code: "OK", message, data });
const refused = (code: string, message: string): StudioMcpResult => ({ outcome: "refused", code, message });
/** Bounded text of the latest inbound message: what the dossier page shows, never the whole history. */
export const STUDIO_MCP_MESSAGE_CHARS = 4000;
const viewSchema = z.union([z.literal("processing"), savIntakeViewSchema]);

/** Identifies one dossier state. Write tools echo it back; the server re-reads and refuses a mismatch. */
export function intakeVersionToken(data: IntakeConsoleDetail) {
  const current = data.current;
  return Buffer.from(JSON.stringify({ v: 1, threadId: data.thread.id, messageId: data.latestMessageId, runId: current?.id ?? null,
    version: current?.version ?? null, sourceHash: current?.sourceHash ?? null, epoch: data.projection.epoch })).toString("base64url");
}
/** The dossier as the console page states it, from the same projector and derivations. */
export function intakeDossierSummary(data: IntakeConsoleDetail) {
  const view = intakeDossierView(data), { current, plan, disposition, target } = view;
  const latest = data.messages.find(message => message.id === data.latestMessageId) ?? null;
  const effects = data.progress?.effects ?? [];
  return {
    threadId: data.thread.id, subject: data.thread.subject || "Nouvelle demande", version: current?.version ?? null,
    status: { view: data.projection.view, code: data.projection.status,
      label: view.dirty ? "Mise à jour du traitement en cours" : intakeReasonLabel(data.projection.reason) ?? intakeStatusLabel(data.projection.status) },
    locks: { humanHeld: data.humanHeld, paused: data.thread.paused, handledExternally: data.handledExternally, blocked: Boolean(view.blocked),
      unsettledEffects: effects.filter(effect => ["dispatched", "acked", "uncertain"].includes(effect.state)).length,
      uncertainExecution: data.progress?.state === "uncertain", pendingHumanEvent: data.choices.some(event => ["pending", "reading"].includes(event.state)),
      holdEpoch: data.projection.epoch },
    confirmedCurrent: data.confirmedCurrent,
    decision: plan ? { classification: plan.decision.classification, route: intakeRouteLabel(disposition),
      contactId: target?.contactId ?? null, ticketId: target && target.operation !== "create" ? target.ticketId : null } : null,
    candidates: { contactIds: view.contacts, ticketIds: view.tickets },
    question: view.question, handoff: view.handoff,
    // Provenance as the page states it: effects of the current run, or retained from another run/version.
    execution: data.progress ? { executionId: data.progress.executionId, runId: data.progress.runId, version: data.progress.version, state: data.progress.state,
      applicability: view.currentEffects ? "current" as const : "historical" as const, title: intakeEffectsTitle(view.currentEffects),
      currentRunId: current?.id ?? null, currentVersion: current?.version ?? null } : null,
    effects: effects.map(effect => ({ kind: effect.kind, label: intakeEffectLabels[effect.kind] ?? effect.kind, state: effect.state,
      stateLabel: intakeEffectStateLabels[effect.state] ?? effect.state, confirmedAt: effect.confirmedAt?.toISOString() ?? null })),
    waitingReason: data.progress?.reason ? intakeReasonLabel(data.progress.reason) : null,
    linkedTicketId: data.confirmedCurrent ? data.progress?.ticketId ?? null : null,
    lastMessage: latest ? { id: latest.id, fromEmail: latest.fromEmail, receivedAt: latest.receivedAt?.toISOString() ?? null,
      text: latest.body.text.slice(0, STUDIO_MCP_MESSAGE_CHARS), truncated: latest.body.text.length > STUDIO_MCP_MESSAGE_CHARS,
      attachments: latest.body.attachments.map(a => a.filename) } : null,
    history: { messages: data.messages.length, truncated: data.historyTruncated },
    versionToken: intakeVersionToken(data),
  };
}

/** The write tools this staff member could use now, with the dossier page's own conditions and
 * the same async readers (operator panel, manual Other binding). Advisory: each write re-checks. */
export async function intakeAvailableActions(data: IntakeConsoleDetail, staff: Staff) {
  const view = intakeDossierView(data), actions = intakeDossierActions(data, view, staff);
  const panel = actions.administrator && actions.operatorBinding ? await readOperatorPanel(actions.operatorBinding).catch(() => null) : null;
  const manualOther = actions.manualOtherCandidate && data.latestMessageId ? await readManualOtherBinding(data.thread.id, data.latestMessageId, data.projection.epoch).catch(() => null) : null;
  return [
    { tool: "close_handled_outside", available: actions.closeHandledOutside, requires: "attestHandled: true" },
    { tool: "classify_invalid_source_other", available: actions.classifyInvalidSource, requires: "attest: true" },
    { tool: "classify_other", available: Boolean(manualOther), requires: "attest: true, reason" },
    { tool: "release_hold", available: actions.releaseHold, requires: "reason" },
    { tool: "record_choice", available: actions.recordChoice, requires: "kind, reason ; contactId/ticketId parmi candidates pour select" },
    { tool: "continue_dossier", available: Boolean(panel && (panel.allowResume || panel.allowReanalysis || panel.allowInformation)),
      kinds: panel ? { resume: panel.allowResume, reanalyse: panel.allowReanalysis, information: panel.allowInformation } : null, unavailableReason: panel?.unavailableReason ?? null },
    { tool: "request_reinvestigation", available: actions.administratorVerifications, requires: "reason" },
    { tool: "reconcile_note", available: actions.administratorVerifications && actions.noteReceipt },
    { tool: "reconcile_identification", available: actions.administratorVerifications },
  ];
}
const listDossiers = { name: "list_dossiers", title: "Lister les dossiers SAV", write: false,
  description: "Liste les dossiers de la console des nouveaux dossiers SAV (25 par page), avec les compteurs de chaque vue. Mêmes données et libellés que la console.",
  input: z.object({ view: viewSchema.default("processing"), search: z.string().max(120).optional(), page: z.number().int().min(1).max(10000).default(1),
    sort: z.enum(["newest", "oldest"]).default("newest") }).strict(),
  async run(_context: StudioMcpContext, input: { view: z.infer<typeof viewSchema>; search?: string; page: number; sort: "newest" | "oldest" }) {
    const data = await listIntakeConsole({ view: input.view, search: input.search, page: input.page, ...(input.sort === "oldest" ? { sort: "oldest" as const } : {}) });
    if (!data.installed) return refused("SAV_INTAKE_CONSOLE_NOT_INSTALLED", "La console des nouveaux dossiers n’est pas préparée.");
    return done({ view: input.view, page: data.page, pages: data.pages, total: data.total,
      counts: { processing: data.counts.processing ?? 0, blocked: data.counts.blocked ?? 0, ...Object.fromEntries(Object.keys(savIntakeViewLabels).map(key => [key, data.counts[key] ?? 0])) },
      rows: data.rows.map(row => ({ threadId: row.threadId, messageId: row.messageId, subject: row.subject || "Nouvelle demande", fromEmail: row.fromEmail,
        receivedAt: row.receivedAt?.toISOString() ?? null, updatedAt: row.updatedAt?.toISOString() ?? null, version: row.version, view: row.view, status: row.status,
        blocked: Boolean(row.blockedCause), blockedCause: row.blockedCause,
        label: row.blockedCause ? intakeBlockedCauseLabel(row.blockedCause) : row.retryAt ? intakeRetryLabel(row.retryAt) : intakeStatusLabel(row.status),
        reason: row.reason ? intakeReasonLabel(row.reason) : null })) });
  } };
const getDossier = { name: "get_dossier", title: "Lire un dossier SAV", write: false,
  description: "Lit un dossier : état, verrous, décision courante, actions confirmées ou incertaines, dernier message (borné) et jeton de version à renvoyer avec toute écriture.",
  input: z.object({ threadId: z.uuid() }).strict(),
  async run(context: StudioMcpContext, input: { threadId: string }) {
    const data = await readIntakeConsoleDetail(input.threadId);
    if (!data) return refused("SAV_INTAKE_DOSSIER_NOT_FOUND", "Dossier introuvable dans la console des nouveaux dossiers.");
    return done({ ...intakeDossierSummary(data), availableActions: await intakeAvailableActions(data, context.staff) });
  } };
const getDiagnostics = { name: "get_diagnostics", title: "Diagnostic technique d’un dossier", write: false,
  description: "Historique des analyses, tentatives, réveils, effets et derniers codes de refus. Réservé aux administrateurs, comme l’API de diagnostic.",
  input: z.object({ threadId: z.uuid() }).strict(),
  async run(context: StudioMcpContext, input: { threadId: string }) {
    // Same rule as GET /api/internal/sav/intake/[id]/diagnostics: role admin exactly.
    if (context.staff.role !== "admin") return refused("SAV_INTAKE_DIAGNOSTICS_FORBIDDEN", "Diagnostic réservé aux administrateurs.");
    const diagnostics = await readIntakeRunDiagnostics(input.threadId);
    return diagnostics ? done(diagnostics) : refused("SAV_INTAKE_DOSSIER_NOT_FOUND", "Aucun diagnostic pour ce dossier.");
  } };
const getBudget = { name: "get_budget", title: "Budget IA de l’intake", write: false,
  description: "Plafond effectif, dépense confirmée, réservations et coûts incertains, glissant 30 jours et appels. Mêmes chiffres que la page Budget IA, réservée au propriétaire du budget. Lecture seule.",
  input: z.object({}).strict(),
  async run(context: StudioMcpContext) {
    const panel = await readIntakeBudgetPanel(() => intakeBudgetOwnerFor(context.user));
    return done(panel);
  } };
const whoami = { name: "whoami", title: "Identité Studio", write: false,
  description: "Le membre de l’équipe authentifié par ce jeton, avec son rôle Studio.",
  input: z.object({}).strict(),
  async run(context: StudioMcpContext) { return done({ email: context.staff.email, role: context.staff.role, name: context.staff.name }); } };

/** Read-only tools of this lot. Write tools (SAV-27 to SAV-30) register with write: true. */
export const studioMcpTools: StudioMcpTool[] = [whoami, listDossiers, getDossier, getDiagnostics, getBudget] as unknown as StudioMcpTool[];
