import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { completeSavDossierManually } from "@/lib/sav/external-completion";
import { classifyInvalidSourceAsOther } from "@/lib/sav/intake/invalid-source-classification";
import { classifyValidSourceAsOther, readManualOtherBinding } from "@/lib/sav/intake/manual-other-classification";
import { releaseIntakeHumanHold } from "@/lib/sav/intake/human-hold-release";
import { recordIntakeHumanCommand } from "@/lib/sav/intake/human-commands";
import { requestIntakeReinvestigation, reconcileThreadIdentification } from "@/lib/sav/intake/operator-recovery";
import { reconcileIntakeNoteForClosure } from "@/lib/sav/intake/note-recovery";
import { recordOperatorCommand, readOperatorPanel } from "@/lib/sav/intake-ux/operator-commands";
import { savAgentPauseAdministrator, setSavAgentPause, readSavAgentPausePanel } from "@/lib/sav/intake/agent-pause-admin";
import { readSavAgentPause, SAV_AGENT_PAUSE_LEVELS } from "@/lib/sav/intake/agent-pause";
import { readIntakeConsoleDetail } from "@/lib/sav/intake/console-detail";
import { intakeDossierActions, intakeDossierView, type IntakeConsoleDetail } from "@/lib/sav/intake/dossier-view";
import { intakeRuntimeHash } from "@/lib/sav/intake/runtime-contract";
import { intakeVersionStillCurrent } from "@/lib/sav/intake/version-precondition";
import { intakeVersionToken, type StudioMcpContext, type StudioMcpResult, type StudioMcpTool } from "./tools";

/** SAV-27 write foundation. Every write names the dossier version it was decided on, carries a
 * client idempotency key and is audited as `studio_mcp_write` with the real staff member. The
 * console's own server function then runs, inside withSavRequestUser, with all of its guards; the
 * version read by the agent is passed down and re-checked under that function's own locks. */
const WRITE_AUDIT = { action: "studio_mcp_write", entityType: "studio_mcp_write" } as const;
/** Durable claim of an idempotency key, committed before the action runs. */
const WRITE_CLAIM = { action: "studio_mcp_write_claim", entityType: "studio_mcp_write" } as const;
/** A claimed key whose result is still unknown after this long is reported uncertain, never re-run. */
export const STUDIO_MCP_CLAIM = { waitMs: 3_000, pollMs: 25, staleMs: 120_000 } as const;
const refused = (code: string, message: string): StudioMcpResult => ({ outcome: "refused", code, message });
const done = (message: string, data?: unknown): StudioMcpResult => ({ outcome: "done", code: "OK", message, data });
const alreadyDone = (message: string, data?: unknown): StudioMcpResult => ({ outcome: "already_done", code: "OK", message, data });
const uncertain = (message = "Résultat non établi : l’action a peut-être été appliquée. Relire l’état (get_dossier, get_agent_pause) avant toute nouvelle demande ; ne pas réutiliser cette clé."): StudioMcpResult =>
  ({ outcome: "uncertain", code: "SAV_MCP_RESULT_UNCERTAIN", message });
const reason = z.string().trim().min(10).max(2000);
const dossierInput = { threadId: z.uuid(), versionToken: z.string().min(1).max(1000), idempotencyKey: z.uuid() };
type Dossier = { threadId: string; versionToken: string; idempotencyKey: string };
type Version = { threadId: string; messageId: string | null; runId: string | null; version: number | null; sourceHash: string | null; epoch: number };

export function decodeVersionToken(token: string): Version | null {
  try {
    const value = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    return value?.v === 1 ? { threadId: value.threadId, messageId: value.messageId, runId: value.runId, version: value.version, sourceHash: value.sourceHash, epoch: value.epoch } : null;
  } catch { return null; }
}
/** Early, explicit refusal only: the authority is the re-check under the console function's locks. */
async function currentDossier(input: Dossier): Promise<{ ok: true; data: IntakeConsoleDetail; version: Version } | { ok: false; result: StudioMcpResult }> {
  const version = decodeVersionToken(input.versionToken);
  const no = (result: StudioMcpResult) => ({ ok: false as const, result });
  if (!version || version.threadId !== input.threadId) return no(refused("SAV_MCP_VERSION_TOKEN_INVALID", "Jeton de version illisible ou d’un autre dossier : relire le dossier avec get_dossier."));
  const data = await readIntakeConsoleDetail(input.threadId);
  if (!data) return no(refused("SAV_INTAKE_DOSSIER_NOT_FOUND", "Dossier introuvable dans la console des nouveaux dossiers."));
  if (intakeVersionToken(data) !== input.versionToken) return no(refused("SAV_MCP_DOSSIER_CHANGED", "Le dossier a changé depuis la lecture : relire avec get_dossier avant de décider."));
  return { ok: true as const, data, version };
}
const payloadHash = (tool: string, input: unknown) => intakeRuntimeHash({ tool, input });
const byKey = (kind: { action: string; entityType: string }, key: string) =>
  and(eq(auditLogs.action, kind.action), eq(auditLogs.entityType, kind.entityType), eq(auditLogs.entityId, key));
/** Same key, same request: the first outcome, waited for while it runs. Same key, another request
 * or another staff member: refused, never run. A claim with no recorded result stays uncertain. */
async function priorWrite(key: string, staffId: string, hash: string): Promise<StudioMcpResult | null> {
  const db = requireDb();
  const [claim] = await db.select().from(auditLogs).where(byKey(WRITE_CLAIM, key)).limit(1);
  if (!claim) return null;
  const c = claim.technicalMetadata;
  if (c.staffId !== staffId || c.payloadHash !== hash) return refused("SAV_MCP_IDEMPOTENCY_CONFLICT", "Cette clé d’idempotence a déjà servi pour une autre demande.");
  for (let waited = 0; ; waited += STUDIO_MCP_CLAIM.pollMs) {
    const [row] = await db.select().from(auditLogs).where(byKey(WRITE_AUDIT, key)).limit(1);
    if (row) {
      const m = row.technicalMetadata;
      return m.outcome === "refused" ? refused(String(m.code), "Refus déjà rendu pour cette même demande.")
        : m.outcome === "uncertain" ? uncertain() : alreadyDone("Demande déjà traitée avec cette clé.", { code: m.code });
    }
    if (Date.now() - claim.createdAt.getTime() >= STUDIO_MCP_CLAIM.staleMs) return uncertain();
    if (waited >= STUDIO_MCP_CLAIM.waitMs) return refused("SAV_MCP_WRITE_IN_PROGRESS", "Une demande avec cette clé est encore en cours : réessayer avec la même clé plus tard.");
    await new Promise(resolve => setTimeout(resolve, STUDIO_MCP_CLAIM.pollMs));
  }
}
/** Serialized across instances by a transaction-scoped database lock on the key; the claim is
 * committed before any console function runs. Null when this call owns the key. */
async function claimWrite(key: string, context: StudioMcpContext, tool: string, hash: string): Promise<StudioMcpResult | null> {
  const won = await requireDb().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`studio-mcp-write:${key}`}))`);
    const [existing] = await tx.select({ id: auditLogs.id }).from(auditLogs).where(byKey(WRITE_CLAIM, key)).limit(1);
    if (existing) return false;
    await tx.insert(auditLogs).values({ actorEmail: context.staff.email, ...WRITE_CLAIM, entityId: key,
      technicalMetadata: { channel: "mcp", tool, staffId: context.staff.id, payloadHash: hash } });
    return true;
  });
  return won ? null : await priorWrite(key, context.staff.id, hash) ?? uncertain();
}
/** `claim` must be awaited right before the console function: reads and refusals before it act on nothing. */
type Claim = () => Promise<StudioMcpResult | null>;
export function studioMcpWrite<T extends z.ZodRawShape>(name: string, title: string, description: string, shape: T,
  run: (context: StudioMcpContext, input: z.infer<z.ZodObject<T>>, claim: Claim) => Promise<StudioMcpResult>,
  options: { idempotent?: boolean; authorize?: () => Promise<unknown> } = {}): StudioMcpTool {
  const input = z.object(shape).strict();
  return { name, title, description, write: true, input, async run(context: StudioMcpContext, raw: never) {
    const values = raw as z.infer<z.ZodObject<T>> & { idempotencyKey?: string; threadId?: string };
    // The tool's own authority comes first: no replay, precondition or no-op answer without it.
    if (options.authorize) await options.authorize();
    const key = options.idempotent === false ? null : values.idempotencyKey ?? null, hash = payloadHash(name, values);
    if (key) { const prior = await priorWrite(key, context.staff.id, hash); if (prior) return prior; }
    let acted = !key;
    const claim: Claim = async () => { if (!key) return null; const lost = await claimWrite(key, context, name, hash); acted = !lost; return lost; };
    const result = await run(context, values, claim).catch((error: unknown): StudioMcpResult => {
      // Console functions refuse inside their transaction: a SAV_* error committed nothing.
      const code = error instanceof Error && /^SAV_[A-Z0-9_]{1,90}$/.test(error.message) ? error.message : error instanceof z.ZodError ? "SAV_MCP_INVALID_INPUT" : null;
      if (code) return refused(code, "Refusé par le contrôle serveur existant ; rien n’a été modifié par cet outil.");
      console.error("studio_mcp_write_failed", { tool: name, acted });
      return acted ? uncertain() : refused("MCP_INTERNAL_ERROR", "Erreur interne avant toute action : rien n’a été tenté.");
    });
    if (!acted) return result;
    // Durable receipt of the result. If it cannot be written, the action itself is not denied:
    // the caller gets the real result, and a retry with this key answers uncertain.
    try {
      await requireDb().insert(auditLogs).values({ actorEmail: context.staff.email, ...WRITE_AUDIT, entityId: key ?? randomUUID(),
        technicalMetadata: { channel: "mcp", tool: name, staffId: context.staff.id, payloadHash: hash, outcome: result.outcome, code: result.code, threadId: values.threadId ?? null } });
    } catch { console.error("studio_mcp_write_receipt_failed", { tool: name, outcome: result.outcome }); }
    if (result.outcome !== "refused" && values.threadId) { revalidatePath(`/studio/sav/intake/${values.threadId}`); revalidatePath("/studio/sav/intake"); }
    return result;
  } };
}
const versionGuard = (version: Version) => (tx: Parameters<typeof intakeVersionStillCurrent>[0], message: { threadId: string }) => intakeVersionStillCurrent(tx, message.threadId, version);
const completion = (result: { marked: number; alreadyCompleted: number; skipped: Record<string, number> }, okMessage: string) =>
  result.marked ? done(okMessage) : result.alreadyCompleted ? alreadyDone("Déjà fait pour ce message.")
    : result.skipped.active_worker ? refused("SAV_MCP_ACTIVE_WORKER", "Un traitement est encore en cours : réessayer après sa fin.")
      : result.skipped.unsettled_action ? refused("SAV_MCP_UNSETTLED_ACTION", "Une action ou un résultat externe reste à vérifier : dossier conservé en attente.")
        : refused("SAV_MCP_DOSSIER_CHANGED", "Le dossier a changé ou ne peut pas être traité ainsi : relire avant de réessayer.");
const unavailable = (what: string) => refused("SAV_MCP_ACTION_UNAVAILABLE", `${what} n’est pas proposé sur ce dossier pour vous, comme dans la console.`);

const closeHandledOutside = studioMcpWrite("close_handled_outside", "Passer en Terminés (déjà traité)",
  "Passe le dernier message en Terminés comme traité hors Studio. Aucun mail envoyé, aucun ticket HubSpot fermé. Réservé à l’opérateur autorisé, comme dans la console. Exige attestHandled: true.",
  { ...dossierInput, attestHandled: z.literal(true) }, async (context, input, claim) => {
    const found = await currentDossier(input); if (!found.ok) return found.result;
    const view = intakeDossierView(found.data);
    if (!intakeDossierActions(found.data, view, context.staff).closeHandledOutside || !found.version.messageId) return unavailable("Le passage en Terminés");
    const lost = await claim(); if (lost) return lost;
    return completion(await completeSavDossierManually({ requestKey: input.idempotencyKey, threadId: input.threadId, messageId: found.version.messageId, confirmed: true }, versionGuard(found.version)),
      "Dossier passé en Terminés : déjà traité. Aucun mail envoyé ni ticket HubSpot fermé.");
  });
const classifyInvalidSource = studioMcpWrite("classify_invalid_source_other", "Classer une source invalide dans Autres",
  "Classe dans Autres un message dont la source est invalide. Aucune analyse IA, aucun mail, aucune action HubSpot. Exige attest: true.",
  { ...dossierInput, attest: z.literal(true) }, async (context, input, claim) => {
    const found = await currentDossier(input); if (!found.ok) return found.result;
    if (!intakeDossierActions(found.data, intakeDossierView(found.data), context.staff).classifyInvalidSource || !found.version.messageId) return unavailable("Ce classement");
    const lost = await claim(); if (lost) return lost;
    return completion(await classifyInvalidSourceAsOther({ requestKey: input.idempotencyKey, threadId: input.threadId, messageId: found.version.messageId, confirmed: true }, found.version),
      "Dossier classé dans Autres. Aucune analyse IA, aucun mail ni aucune action HubSpot.");
  });
const classifyOther = studioMcpWrite("classify_other", "Classer dans Autres (décision humaine)",
  "Classe le message courant dans Autres sur décision de l’opérateur, sans verdict IA, mail ni action HubSpot. Mêmes conditions que la console. Exige attest: true et un motif.",
  { ...dossierInput, reason, attest: z.literal(true) }, async (context, input, claim) => {
    const found = await currentDossier(input); if (!found.ok) return found.result;
    const actions = intakeDossierActions(found.data, intakeDossierView(found.data), context.staff);
    const binding = actions.manualOtherCandidate && found.version.messageId ? await readManualOtherBinding(input.threadId, found.version.messageId, found.data.projection.epoch) : null;
    if (!binding) return unavailable("Le classement dans Autres");
    // The binding is read again: it must still be the version the agent decided on (its epoch is the token's).
    if (binding.runId !== found.version.runId || binding.version !== found.version.version || binding.runSourceHash !== found.version.sourceHash)
      return refused("SAV_MCP_DOSSIER_CHANGED", "Le dossier a changé depuis la lecture : relire avec get_dossier avant de décider.");
    const lost = await claim(); if (lost) return lost;
    return completion(await classifyValidSourceAsOther({ ...binding, requestKey: input.idempotencyKey, reason: input.reason, confirmed: true }),
      "Message classé dans Autres sur votre décision. Aucun verdict IA, mail envoyé ou modification HubSpot.");
  });
const releaseHold = studioMcpWrite("release_hold", "Lever la pause humaine",
  "Lève uniquement la pause humaine du dossier. Ni nouvelle analyse, ni remise à zéro des tentatives. Administrateurs, comme dans la console.",
  { ...dossierInput, reason }, async (context, input, claim) => {
    const found = await currentDossier(input); if (!found.ok) return found.result;
    if (!intakeDossierActions(found.data, intakeDossierView(found.data), context.staff).releaseHold || !found.version.messageId) return unavailable("La levée de pause");
    const lost = await claim(); if (lost) return lost;
    const result = await releaseIntakeHumanHold({ requestKey: input.idempotencyKey, threadId: input.threadId, messageId: found.version.messageId, expectedEpoch: found.version.epoch, reason: input.reason });
    return result.replayed ? alreadyDone("Pause déjà levée par cette même demande.") : done("Pause levée. Le moteur pourra poursuivre si les preuves et la politique le permettent.");
  });
const recordChoice = studioMcpWrite("record_choice", "Choisir la fiche, le ticket ou la classification",
  "Enregistre un choix humain conditionnel sur la version courante : select (contactId et éventuel ticketId parmi les candidats de get_dossier), classify (classification) ou refuse. Le worker revalide les preuves avant toute action.",
  { ...dossierInput, kind: z.enum(["select", "classify", "refuse"]), contactId: z.string().regex(/^\d{1,30}$/).optional(), ticketId: z.string().regex(/^\d{1,30}$/).optional(),
    classification: z.enum(["support", "finance", "cancellation", "other", "partnership", "commercial", "investor"]).optional(), reason }, async (context, input, claim) => {
    const found = await currentDossier(input); if (!found.ok) return found.result;
    const view = intakeDossierView(found.data), { version } = found;
    if (!intakeDossierActions(found.data, view, context.staff).recordChoice || !version.messageId || !version.runId || !version.version || !version.sourceHash) return unavailable("La correction");
    if (input.kind === "select" && (!input.contactId || !view.contacts.includes(input.contactId) || input.ticketId && !view.tickets.includes(input.ticketId)))
      return refused("SAV_MCP_NOT_A_CANDIDATE", "Fiche ou ticket hors des candidats de get_dossier.");
    if (input.kind !== "select" && (input.contactId || input.ticketId) || (input.kind === "classify") !== Boolean(input.classification))
      return refused("SAV_MCP_INVALID_INPUT", "select exige contactId ; classify exige classification ; refuse n’accepte ni l’un ni l’autre.");
    const lost = await claim(); if (lost) return lost;
    const result = await recordIntakeHumanCommand({ commandKey: input.idempotencyKey, threadId: input.threadId, messageId: version.messageId, runId: version.runId,
      version: version.version, sourceHash: version.sourceHash, candidatesHash: intakeRuntimeHash(view.contacts), kind: input.kind,
      ...(input.contactId ? { contactId: input.contactId } : {}), ...(input.ticketId ? { ticketId: input.ticketId } : {}),
      ...(input.classification ? { classification: input.classification } : {}), reason: input.reason });
    return done(input.kind === "refuse" ? "Refus enregistré ; la proposition reste arrêtée." : "Choix enregistré ; le worker revalide les preuves avant toute reprise.", { eventId: result.eventId });
  });
const requestReinvestigation = studioMcpWrite("request_reinvestigation", "Demander une réinvestigation",
  "Enregistre une demande de réinvestigation du message courant, sans remise à zéro des tentatives ni du budget, sans mail. Administrateurs.",
  { ...dossierInput, reason }, async (context, input, claim) => {
    const found = await currentDossier(input); if (!found.ok) return found.result;
    if (!intakeDossierActions(found.data, intakeDossierView(found.data), context.staff).administratorVerifications || !found.version.messageId) return unavailable("La réinvestigation");
    const lost = await claim(); if (lost) return lost;
    const result = await requestIntakeReinvestigation({ threadId: input.threadId, messageId: found.version.messageId, reason: input.reason, commandKey: input.idempotencyKey }, found.version);
    return done("Réinvestigation enregistrée, sans remise à zéro des tentatives ni envoi de mail.", { eventId: result.eventId });
  });
const continueDossier = studioMcpWrite("continue_dossier", "Poursuivre un dossier (reprise, nouvelle analyse, information)",
  "Commande de poursuite du panneau opérateur : resume (reprendre l’étape), reanalyse (refaire l’analyse) ou information (ajouter une information, avec information). Mêmes conditions et budget que la console. Administrateurs.",
  { ...dossierInput, kind: z.enum(["resume", "reanalyse", "information"]), reason, information: z.string().trim().min(1).max(2000).optional() }, async (context, input, claim) => {
    const found = await currentDossier(input); if (!found.ok) return found.result;
    const actions = intakeDossierActions(found.data, intakeDossierView(found.data), context.staff);
    if (!actions.administrator || !actions.operatorBinding) return unavailable("La poursuite");
    const panel = await readOperatorPanel(actions.operatorBinding);
    const allowed = input.kind === "resume" ? panel.allowResume : input.kind === "reanalyse" ? panel.allowReanalysis : panel.allowInformation;
    if (!allowed) return refused("SAV_MCP_ACTION_UNAVAILABLE", panel.unavailableReason);
    if ((input.kind === "information") !== Boolean(input.information)) return refused("SAV_MCP_INVALID_INPUT", "information exige le texte ; resume et reanalyse ne l’acceptent pas.");
    const lost = await claim(); if (lost) return lost;
    const receipt = await recordOperatorCommand({ requestKey: input.idempotencyKey, ...actions.operatorBinding, kind: input.kind, reason: input.reason,
      ...(input.kind === "information" ? { information: input.information, expectedInformationId: (panel.information as { id?: string } | null)?.id ?? null } : {}) });
    return done("Demande enregistrée ; le traitement existant la reprendra après ses contrôles. Aucun effet annoncé comme accompli.", { receipt });
  });
const reconcileNote = studioMcpWrite("reconcile_note", "Vérifier la note déjà rattachée",
  "Vérifie le reçu d’une note HubSpot existante et son rattachement avant clôture. Ne crée aucune note. Administrateurs.",
  { threadId: z.uuid(), versionToken: dossierInput.versionToken }, async (context, input) => {
    const found = await currentDossier({ ...input, idempotencyKey: "" }); if (!found.ok) return found.result;
    const actions = intakeDossierActions(found.data, intakeDossierView(found.data), context.staff);
    if (!actions.administratorVerifications || !actions.noteReceipt || !found.version.messageId) return unavailable("La vérification de note");
    await reconcileIntakeNoteForClosure({ threadId: input.threadId, messageId: found.version.messageId });
    return done("Note existante et rattachement vérifiés. Aucune note créée ni aucun mail envoyé.");
  }, { idempotent: false });
const reconcileIdentification = studioMcpWrite("reconcile_identification", "Rapprocher les envois d’identification",
  "Rapproche les demandes d’identification déjà envoyées avec leurs reçus. Ne renvoie aucun mail. Administrateurs.",
  { threadId: z.uuid(), versionToken: dossierInput.versionToken }, async (context, input) => {
    const found = await currentDossier({ ...input, idempotencyKey: "" }); if (!found.ok) return found.result;
    if (!intakeDossierActions(found.data, intakeDossierView(found.data), context.staff).administratorVerifications) return unavailable("Le rapprochement");
    const result = await reconcileThreadIdentification(input.threadId);
    return done(`${result.confirmed} envoi(s) existant(s) rapproché(s). Aucun mail renvoyé.`, { confirmed: result.confirmed });
  }, { idempotent: false });
const setAgentPause = studioMcpWrite("set_agent_pause", "Mettre l’agent en pause ou le relancer",
  "Change le niveau de l’agent SAV : running, actions_paused (analyse sans actions HubSpot/Gmail) ou fully_paused. expectedLevel doit être le niveau lu par get_agent_pause ; expectedSetAt (state.setting.setAt lu, ou null) refuse aussi tout changement intermédiaire. Administrateurs, comme la page Pause.",
  { level: z.enum(SAV_AGENT_PAUSE_LEVELS), expectedLevel: z.enum(SAV_AGENT_PAUSE_LEVELS), expectedSetAt: z.iso.datetime().nullable().optional(),
    reason: z.string().trim().min(3).max(500), idempotencyKey: z.uuid() }, async (_context, input, claim) => {
    const changed = (level: string) => refused("SAV_MCP_PAUSE_CHANGED", `Le niveau actuel est ${level} : relire avec get_agent_pause.`);
    const current = await readSavAgentPause(requireDb(), "intake");
    if (current.level !== input.expectedLevel || input.expectedSetAt !== undefined && (current.setting?.setAt ?? null) !== input.expectedSetAt) return changed(current.level);
    if (current.level === input.level && !current.invalid) return alreadyDone(`L’agent est déjà au niveau ${input.level}.`);
    const lost = await claim(); if (lost) return lost;
    // The precondition is compared again by the setter, under the budget lock, before any write.
    const next = await setSavAgentPause({ agent: "intake", level: input.level, reason: input.reason, expectedLevel: input.expectedLevel,
      ...(input.expectedSetAt !== undefined ? { expectedSetAt: input.expectedSetAt } : {}) })
      .catch((error: unknown) => { if (error instanceof Error && error.message === "SAV_AGENT_PAUSE_CHANGED") return null; throw error; });
    return next ? done(`Niveau de l’agent : ${next.level}.`, { level: next.level, setAt: next.setAt }) : changed("différent de celui attendu");
  }, { authorize: savAgentPauseAdministrator });
const getAgentPause = { name: "get_agent_pause", title: "État de pause de l’agent", write: false, input: z.object({}).strict(),
  description: "Niveau actuel de l’agent SAV (running, actions_paused, fully_paused), qui l’a réglé, quand, pourquoi, et les derniers changements. Administrateurs, comme la page Pause.",
  async run() { const panel = await readSavAgentPausePanel(); return { outcome: "done", code: "OK", message: "OK", data: panel } as StudioMcpResult; } } as unknown as StudioMcpTool;

export const studioMcpWriteTools: StudioMcpTool[] = [closeHandledOutside, classifyInvalidSource, classifyOther, releaseHold, recordChoice,
  requestReinvestigation, continueDossier, reconcileNote, reconcileIdentification, setAgentPause];
export const studioMcpPauseReadTool = getAgentPause;
