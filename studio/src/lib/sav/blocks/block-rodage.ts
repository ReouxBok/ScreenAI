import "server-only";
import { createHash } from "node:crypto";
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, savCases, savCaseEvents, savSyncState } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { executionAdministrator } from "../intake/execution-policy";
import { caseAdmissionQualificationSchema, SAV_CASE_BLOCK_ID, type CaseAdmissionRecord } from "../cases/case-types";
import { caseRuleBlockId } from "../cases/case-blocks";
import { caseDecisionProposalSchema, caseDecisionRejectionLabels } from "../cases/decision-contract";
import { readCaseInvestigationProgress, SAV_CASE_INVESTIGATION_RECORD_KIND, type CaseInvestigationJournalEvent } from "../cases/investigation-record";

export const RODAGE_REVISION = "sav-block-rodage.v1";
export const RODAGE_CATEGORIES = ["mauvaise fiche", "mauvais ton", "mauvaise question", "hors bloc", "sensible raté"] as const;
export const RODAGE_THRESHOLDS = Object.freeze({ minDrafts: 10, minGoodRatio: 0.9, maxSensitiveMissed: 0, maxOutOfBlock: 0 });
const blockSchema = z.string().regex(SAV_CASE_BLOCK_ID);
export const rodageWindowSchema = z.object({ blockId: blockSchema, from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }).strict()
  .refine(v => Date.parse(v.to) > Date.parse(v.from) && Date.parse(v.to) - Date.parse(v.from) <= 86_400_000, "Fenêtre requise : plus de 0 et au maximum 24 heures");
const verdictInputSchema = z.object({ blockId: blockSchema, caseId: z.uuid(), draftId: z.string().regex(/^[a-f0-9]{64}$/),
  verdict: z.enum(["bon", "à corriger", "hors périmètre"]), category: z.enum(RODAGE_CATEGORIES).nullable(), reason: z.string().trim().max(2000),
}).strict().refine(v => v.verdict === "à corriger" ? v.category !== null && v.reason.length >= 3 : v.category === null, "Catégorie et raison requises pour une correction");
const verdictSchema = verdictInputSchema.safeExtend({ revision: z.literal(RODAGE_REVISION), at: z.iso.datetime(), actor: z.string().min(1) });
const verdictEnvelopeSchema = z.object({ revision: z.literal(RODAGE_REVISION), blockId: blockSchema, caseId: z.uuid(), verdicts: z.array(verdictSchema).max(1000) }).strict();
export type RodageVerdict = z.infer<typeof verdictSchema>;
export const rodageKey = (blockId: string, caseId: string) => `${RODAGE_REVISION}:${blockId}:${caseId}`;
export async function rodageAdministrator() { return executionAdministrator(); }
export type RodageCase = {
  caseId: string; admitted: boolean; summary: string; draftId: string | null; proposedAt: string | null;
  action: string; responseSummary: string; responseText: string | null; sensitiveMissed: boolean; citations: { knowledgeId: string; contentVersionId: string }[];
  refusals: string[]; afterwards: string[]; verdict: RodageVerdict | null;
};
export type RodageReport = { blockId: string; from: string; to: string; incomplete: boolean; historyUncertain?: boolean; cases: RodageCase[] };
const actionLabels = { answer: "répondre", ask: "demander", handoff: "passer à l’équipe", confirm_resolution: "confirmer la résolution", observe_only: "observer" };
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Journal = CaseInvestigationJournalEvent & { id: string; direction: string; occurredAt: Date };

/** Structural request summaries and closed refusal codes; proposed reply text stays in the admin UI only. */
export function projectRodageCase(caseId: string, admission: CaseAdmissionRecord, events: Journal[], blockId: string): RodageCase | null {
  const parsed = caseAdmissionQualificationSchema.parse(admission.qualification);
  const requests = parsed.requests.filter(r => r.provenance.kind === "qualified_rule" && caseRuleBlockId({ ...r.provenance, family: r.family === "unknown" ? "other" : r.family }) === blockId);
  if (!requests.length) return null;
  const observations = events.filter(e => e.kind === "observation_recorded" && (e.detail?.record as { kind?: unknown } | undefined)?.kind === SAV_CASE_INVESTIGATION_RECORD_KIND);
  const latest = observations.at(-1);
  const record = latest?.detail?.record as { inputKey?: unknown } | undefined;
  const read = typeof record?.inputKey === "string" ? readCaseInvestigationProgress(observations, record.inputKey) : { state: "none" as const };
  const stored = read.state === "found" ? read.record : null;
  const proposal = caseDecisionProposalSchema.safeParse(stored?.progress.proposal?.output ?? (stored?.decision?.validation.outcome === "accepted" ? stored.decision.validation.decision : undefined));
  const decision = proposal.success ? proposal.data : null;
  const refusals = new Set<string>();
  let sensitiveFound = false;
  for (const event of observations) {
    const key = (event.detail?.record as { inputKey?: unknown } | undefined)?.inputKey;
    if (typeof key !== "string") { refusals.add("record_unreadable"); continue; }
    const result = readCaseInvestigationProgress([event], key);
    if (result.state !== "found") { refusals.add("record_unreadable"); continue; }
    sensitiveFound ||= result.record.decision?.flags?.sensitiveFoundByModel === true;
    for (const attempt of result.record.progress.attempts) if (attempt.result === "validated")
      for (const code of attempt.codes) if (Object.hasOwn(caseDecisionRejectionLabels, code)) refusals.add(code);
  }
  const afterwards = events.filter(e => latest && e.caseVersion > latest.caseVersion).flatMap(e => e.kind === "inbound_confirmed" ? ["le client a répondu"] : e.kind === "outbound_observed" && e.direction === "human_outbound" ? ["un humain a répondu"] : []);
  // Closure evidence is taken only from recorded decisions, never from a current phase outside the window.
  if (stored?.decision?.closure?.plan === "soft_close") afterwards.push("fermeture proposée");
  if (events.some(e => e.kind === "owner_changed" && ["resolved", "closed_no_reply"].includes(String(e.detail?.toPhase)))) afterwards.push("fermeture observée");
  const action = decision ? actionLabels[decision.nextAction.kind] : "non disponible";
  return { caseId, admitted: admission.target === "agent", summary: `${requests.length} demande(s) du bloc ${blockId} (${[...new Set(requests.map(r => r.family))].join(", ")})`,
    draftId: decision?.reply && latest ? fingerprint([caseId, record?.inputKey, stored?.progress.proposal?.proposedOn ?? latest.id, decision]) : null, proposedAt: latest?.occurredAt.toISOString() ?? null,
    action, responseText: decision?.reply?.text ?? null, sensitiveMissed: sensitiveFound || refusals.has("sensitive_requires_human"), responseSummary: decision?.reply ? `${action} ; ${decision.reply.citations.length} fiche(s) citée(s)` : "Aucune réponse proposée lisible",
    citations: decision?.reply?.citations ?? [], refusals: [...refusals], afterwards: [...new Set(afterwards)], verdict: null };
}

export function rodageGoNoGo(report: RodageReport, thresholds = RODAGE_THRESHOLDS) {
  const drafts = report.cases.filter(c => c.admitted && c.draftId);
  const good = drafts.filter(c => c.verdict?.verdict === "bon").length;
  const sensitiveMissed = new Set(report.cases.filter(c => c.admitted && (c.sensitiveMissed || c.verdict?.category === "sensible raté")).map(c => c.caseId)).size;
  const outOfBlock = new Set(report.cases.filter(c => c.admitted && (c.verdict?.category === "hors bloc" || c.verdict?.verdict === "hors périmètre")).map(c => c.caseId)).size;
  const refusedByReason: Record<string, number> = {};
  const refusalCases = new Map<string, Set<string>>();
  for (const c of report.cases) for (const code of c.refusals) {
    const ids = refusalCases.get(code) ?? new Set<string>(); ids.add(c.caseId); refusalCases.set(code, ids);
  }
  for (const [code, ids] of refusalCases) refusedByReason[code] = ids.size;
  const verdicts = { bon: good, "à corriger": drafts.filter(c => c.verdict?.verdict === "à corriger").length, "hors périmètre": drafts.filter(c => c.verdict?.verdict === "hors périmètre").length };
  const result = report.historyUncertain ? "historique incertain" : report.incomplete || report.cases.some(c => c.refusals.includes("record_unreadable")) || sensitiveMissed > thresholds.maxSensitiveMissed || outOfBlock > thresholds.maxOutOfBlock ? "corriger puis recommencer"
    : drafts.length < thresholds.minDrafts ? "pas assez de volume" : good / drafts.length >= thresholds.minGoodRatio ? "prêt pour auto" : "corriger puis recommencer";
  return { result, admitted: new Set(report.cases.filter(c => c.admitted).map(c => c.caseId)).size, drafts: drafts.length, good, goodRatio: drafts.length ? good / drafts.length : 0,
    sensitiveMissed, outOfBlock, refusedByReason, handoffs: new Set(report.cases.filter(c => c.action === actionLabels.handoff).map(c => c.caseId)).size, verdicts };
}

/** Selects only; never calls a case-store reader capable of upgrading a dossier. Current admission provenance is required. */
export async function readRodageReport(raw: unknown): Promise<RodageReport> {
  await rodageAdministrator();
  const input = rodageWindowSchema.parse(raw), db = requireDb();
  const rows = await db.select().from(savCases).where(and(gte(savCases.updatedAt, new Date(input.from)), lt(savCases.createdAt, new Date(input.to))))
    .orderBy(asc(savCases.id)).limit(501);
  const report: RodageReport = { ...input, incomplete: rows.length > 500, cases: [] };
  for (const row of rows.slice(0, 500)) {
    if (!row.admissionCiphertext) continue;
    // A later overwritten admission cannot certify the requested historical window.
    if (row.admissionDecidedAt && row.admissionDecidedAt >= new Date(input.to)) { report.incomplete = true; report.historyUncertain = true; continue; }
    const admission = decryptSavPayload<CaseAdmissionRecord>(row.admissionCiphertext);
    const events = await db.select().from(savCaseEvents).where(and(eq(savCaseEvents.caseId, row.id), gte(savCaseEvents.occurredAt, new Date(input.from)), lt(savCaseEvents.occurredAt, new Date(input.to))))
      .orderBy(asc(savCaseEvents.caseVersion)).limit(1001);
    if (events.length > 1000) report.incomplete = true;
    if (!events.length) continue;
    const journal = events.slice(0, 1000).map(e => ({ ...e, detail: decryptSavPayload<{ detail: Record<string, unknown> | null }>(e.payloadCiphertext).detail }));
    // Each distinct proposal is reviewed; resumptions carrying the same proposal do not inflate volume.
    const proposals = new Map<string, RodageCase>();
    const observations = journal.filter(e => e.kind === "observation_recorded" && (e.detail?.record as { kind?: unknown } | undefined)?.kind === SAV_CASE_INVESTIGATION_RECORD_KIND);
    for (const observation of observations) {
      const key = (observation.detail?.record as { inputKey?: unknown } | undefined)?.inputKey;
      const read = typeof key === "string" ? readCaseInvestigationProgress([observation], key) : { state: "none" as const };
      // Admission events omit the old qualification: a replacement cannot be used
      // retroactively, even if it happened inside this window or before a resumption.
      const proposalVersion = read.state === "found"
        ? read.record.progress.proposal?.proposedOn ?? read.record.decision?.caseVersion ?? observation.caseVersion
        : observation.caseVersion;
      if (admission.version > proposalVersion) report.historyUncertain = true;
      const view = journal.filter(e => e.kind !== "observation_recorded" || e.caseVersion <= observation.caseVersion);
      const item = projectRodageCase(row.id, admission, view, input.blockId);
      if (item?.draftId) proposals.set(item.draftId, item);
      if (item?.refusals.includes("record_unreadable")) report.incomplete = true;
    }
    if (proposals.size) report.cases.push(...proposals.values());
    else { const item = projectRodageCase(row.id, admission, journal, input.blockId); if (item) report.cases.push(item); }
  }
  if (report.cases.length) {
    const verdicts = await db.select().from(savSyncState).where(inArray(savSyncState.key, report.cases.map(c => rodageKey(input.blockId, c.caseId))));
    for (const c of report.cases) {
      const row = verdicts.find(v => v.key === rodageKey(input.blockId, c.caseId));
      if (!row) continue;
      const envelope = verdictEnvelopeSchema.parse(decryptSavPayload(row.cursor!));
      if (envelope.blockId !== input.blockId || envelope.caseId !== c.caseId || envelope.verdicts.some(v => v.blockId !== input.blockId || v.caseId !== c.caseId)) throw Error("SAV_RODAGE_VERDICT_MISMATCH");
      c.verdict = envelope.verdicts.find(v => v.draftId === c.draftId) ?? null;
    }
  }
  return report;
}

/** An annotation is bound to the precise draft shown; it cannot approve or send anything. */
export async function saveRodageVerdict(raw: unknown, window: unknown) {
  const actor = await rodageAdministrator(), input = verdictInputSchema.parse(raw);
  const report = await readRodageReport(window);
  const item = report.cases.find(c => c.caseId === input.caseId && c.draftId === input.draftId);
  if (report.blockId !== input.blockId || !item?.draftId || item.draftId !== input.draftId || report.incomplete || report.historyUncertain) throw Error("SAV_RODAGE_DRAFT_STALE");
  const next: RodageVerdict = { ...input, revision: RODAGE_REVISION, actor: actor.email, at: new Date().toISOString() };
  await requireDb().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${rodageKey(input.blockId, input.caseId)}))`);
    const key = rodageKey(input.blockId, input.caseId);
    const [previous] = await tx.select().from(savSyncState).where(eq(savSyncState.key, key));
    const envelope = previous ? verdictEnvelopeSchema.parse(decryptSavPayload(previous.cursor!)) : { revision: RODAGE_REVISION, blockId: input.blockId, caseId: input.caseId, verdicts: [] };
    if (envelope.blockId !== input.blockId || envelope.caseId !== input.caseId) throw Error("SAV_RODAGE_VERDICT_MISMATCH");
    const payload = verdictEnvelopeSchema.parse({ ...envelope, verdicts: [...envelope.verdicts.filter(v => v.draftId !== next.draftId), next] });
    const values = { key, cursor: encryptSavPayload(payload), status: "active", updatedAt: new Date(next.at) };
    await tx.insert(savSyncState).values(values).onConflictDoUpdate({ target: savSyncState.key, set: values });
    await tx.insert(auditLogs).values({ actorEmail: actor.email, action: "sav_block_rodage_verdict", entityType: "sav_block_rodage", entityId: input.caseId,
      technicalMetadata: { blockId: input.blockId, draftId: input.draftId, verdict: input.verdict, category: input.category, revision: RODAGE_REVISION } });
  });
}

/** Deliberately omits all free text, including human reasons: those can contain pasted client text. */
export function exportRodageMarkdown(report: RodageReport) {
  const stats = rodageGoNoGo(report);
  return [`# Rodage du bloc ${blockSchema.parse(report.blockId)}`, `${report.from} → ${report.to}`, `Résultat : ${stats.result}`,
    `Admis : ${stats.admitted} ; brouillons : ${stats.drafts} ; bons : ${stats.good} ; passages à l’équipe : ${stats.handoffs}`,
    `Sensible raté : ${stats.sensitiveMissed} ; hors bloc admis : ${stats.outOfBlock}`, `Refus : ${JSON.stringify(stats.refusedByReason)}`,
    `Verdicts : ${JSON.stringify(stats.verdicts)}`, `Lecture limitée : ${report.incomplete ? "oui" : "non"}`,
    `Historique incertain : ${report.historyUncertain ? "oui" : "non"}. Une admission remplacée après une proposition interdit GO : sa qualification historique n’est pas disponible.`,
    "Les résumés sont structurels ; les textes clients, réponses et raisons libres restent hors export. Aucune activation.",
    ...report.cases.map(c => `\n## Dossier ${z.uuid().parse(c.caseId)}\nDécision : ${Object.values(actionLabels).includes(c.action) ? c.action : "non disponible"}\nRéponse : ${c.draftId ? "brouillon proposé" : "aucun brouillon"}\nVerdict : ${c.verdict?.verdict ?? "non évalué"} ; catégorie : ${c.verdict?.category ?? "aucune"}\nFiches : ${c.citations.map(k => `${z.uuid().safeParse(k.knowledgeId).success ? k.knowledgeId : "identifiant non UUID"}@${z.uuid().safeParse(k.contentVersionId).success ? k.contentVersionId : "version non UUID"}`).join(", ") || "aucune"}\nSuite : ${c.afterwards.filter(s => ["le client a répondu", "un humain a répondu", "fermeture proposée", "fermeture observée"].includes(s)).join(", ") || "non observée dans la fenêtre"}`),
  ].join("\n\n");
}
