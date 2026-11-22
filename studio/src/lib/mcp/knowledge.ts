import "server-only";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";
import { requireDb } from "@/db";
import { contentItems, knowledgeProjectionCandidates, savKnowledgeActivations, savKnowledgeProposalDrafts } from "@/db/schema";
import { activateSavKnowledgeVersion, getSavKnowledgeDetail, paginateSavKnowledge, previewSavKnowledgeProposal, previewSavKnowledgeReview, publishSavKnowledgeVersion,
  reviewSavKnowledgeProposal, saveSavKnowledgeProposal, submitSavKnowledgeProposal } from "@/lib/knowledge/workspace";
import { assertKnowledgeUgoApproval, canonicalKnowledgeSchema, type CanonicalKnowledge } from "@/lib/knowledge/contracts";
import { assertSavSupportDelivery, savSupportDeliverySchema, type SavSupportDelivery } from "@/lib/knowledge/support-delivery";
import { SavCardUnsafeContentError } from "@/lib/knowledge/onboarding-extraction";
import { savCardFieldLabel } from "@/lib/knowledge/card-checks";
import { knowledgeErrorMessage, knowledgeState } from "@/app/studio/sav/connaissances/workspace-labels";
import { studioMcpWrite } from "./writes";
import type { StudioMcpContext, StudioMcpResult, StudioMcpTool } from "./tools";

/**
 * Studio MCP access to the SAV knowledge fiches (Connaissances page). Each tool calls the page's own domain functions
 * (`@/lib/knowledge/workspace`) with the MCP staff member's email, so drafts, review, publication (indexing, embeddings)
 * and activation follow exactly the UI path and its guards. Administrators only; publication and activation stay
 * reserved to Ugo by the domain itself. Logs carry tool, outcome and code (server.ts), never fiche content.
 */
const refused = (code: string, message: string, data?: unknown): StudioMcpResult => ({ outcome: "refused", code, message, ...(data === undefined ? {} : { data }) });
const done = (message: string, data?: unknown): StudioMcpResult => ({ outcome: "done", code: "OK", message, data });
const forbidden = () => refused("SAV_KNOWLEDGE_MCP_FORBIDDEN", "Fiches SAV réservées aux administrateurs du Studio.");
const isAdmin = (context: StudioMcpContext) => context.staff.role === "admin";

/** Domain refusals keep their stable code; field problems are named by label, never by their text. */
export function knowledgeRefusal(error: unknown): StudioMcpResult | null {
  if (error instanceof ZodError) return refused("SAV_MCP_INVALID_INPUT", `Champs à corriger : ${[...new Set(error.issues.map(issue => savCardFieldLabel(issue.path.join("."))))].slice(0, 10).join(", ")}.`);
  if (error instanceof SavCardUnsafeContentError) return refused(error.message, `Contenu refusé par le contrôle de sécurité des fiches : ${error.fields.map(field => savCardFieldLabel(field.path)).slice(0, 10).join(", ")}.`,
    { fields: error.fields.map(field => ({ path: field.path, problems: field.problems })) });
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,90}$/.test(error.message)) return refused(error.message, knowledgeErrorMessage(error.message));
  return null;
}
async function guarded(run: () => Promise<StudioMcpResult>) {
  try { return await run(); }
  catch (error) { const refusal = knowledgeRefusal(error); if (refusal) return refusal; throw error; }
}
function refresh() {
  // Same cache refresh as the page's server actions; never turns a settled result into a failure.
  try { revalidatePath("/studio/sav/connaissances", "layout"); revalidatePath("/studio/contenus"); revalidatePath("/studio/sav"); }
  catch { console.error("studio_mcp_knowledge_revalidate_failed"); }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable((value as Record<string, unknown>)[key])]));
  return value;
}
type DraftRow = typeof savKnowledgeProposalDrafts.$inferSelect;
/** sha256 (hex) of one saved draft revision: any later edit, from the MCP or the Studio, changes it. */
export function ficheContentHash(draft: Pick<DraftRow, "id" | "revision" | "targetItemId" | "title" | "document" | "sources" | "reason">) {
  return createHash("sha256").update(JSON.stringify(stable({ v: 1, draftId: draft.id, revision: draft.revision, targetItemId: draft.targetItemId, title: draft.title,
    document: draft.document, sources: draft.sources, reason: draft.reason })), "utf8").digest("hex");
}
async function readDraft(id: string) {
  const [draft] = await requireDb().select().from(savKnowledgeProposalDrafts).where(eq(savKnowledgeProposalDrafts.id, id));
  return draft ?? null;
}

/** The simplest qualified rendering: one customer objective with every step, prerequisite and exception (or diagnostic). */
export function defaultFicheDelivery(document: CanonicalKnowledge): SavSupportDelivery {
  if (document.diagnostic?.checks.length) return { version: 1, mode: "diagnostic" };
  return { version: 1, mode: "procedure", internalStepIds: [], groups: [{ id: "fiche.main", label: document.objective.slice(0, 200).padEnd(3, "."), stepIds: document.steps.map(step => step.id), requiresHuman: false,
    prerequisiteIndexes: document.prerequisites.map((_, index) => index), exceptionIndexes: document.exceptions.map((_, index) => index), includeExpectedResult: true, includeEscalation: true }] };
}
function chooseDelivery(document: CanonicalKnowledge, given: SavSupportDelivery | undefined, inherited?: SavSupportDelivery) {
  if (given) return given;
  if (inherited && inherited.mode !== "unclassified") { try { return assertSavSupportDelivery(document, inherited); } catch { /* steps changed: fall back to the simple rendering */ } }
  return defaultFicheDelivery(document);
}

const source = z.object({ ref: z.string().trim().min(3).max(1000), label: z.string().trim().min(3).max(500) }).strict();
const ficheFields = {
  title: z.string().trim().min(3).max(500).describe("Titre de la fiche, tel que l’équipe la retrouve."),
  document: canonicalKnowledgeSchema.describe("Contenu complet de la fiche (schemaVersion 1) : objective, applicability (sav_only ou shared), locale (fr-FR), prerequisites, expectedResult, exceptions, escalation, steps (id unique, userLabel, objective, instruction, expectedResult…) ; supportContext.symptoms = mots-clés / besoins clients."),
  reason: z.string().trim().min(10).max(2000).describe("Motif de la proposition (au moins 10 caractères)."),
  delivery: savSupportDeliverySchema.optional().describe("Restitution qualifiée. Par défaut : un seul objectif client avec toutes les étapes (ou diagnostic si la fiche en a un)."),
  idempotencyKey: z.uuid().describe("Clé UUID propre à cette demande ; la renvoyer telle quelle en cas de nouvel essai."),
};
async function saveDraft(context: StudioMcpContext, input: { title: string; document: CanonicalKnowledge; reason: string; sources: { ref: string; label: string }[] },
  target: { mode: "new" } | { mode: "improve"; itemId: string }, delivery: SavSupportDelivery) {
  const saved = await saveSavKnowledgeProposal({ mode: target.mode, targetItemId: target.mode === "improve" ? target.itemId : null, title: input.title, document: input.document,
    sources: input.sources, reason: input.reason, delivery }, context.staff.email);
  refresh();
  const row = await readDraft(saved.id), preview = await previewSavKnowledgeProposal(saved.id, context.staff.email);
  return done("Brouillon enregistré. Rien n’est actif : la publication n’a lieu qu’avec publish_fiche, sur accord explicite d’Ugo.", {
    draftId: saved.id, revision: saved.revision, contentHash: ficheContentHash(row!), targetItemId: saved.targetItemId, activeVersionId: preview.activeVersion?.id ?? null,
    delivery: preview.draft.delivery.mode, missing: preview.missing, publishable: preview.missing.length === 0 });
}
const draftReceipt = (result: StudioMcpResult) => {
  const data = result.data as { draftId?: string; contentHash?: string; revision?: number } | undefined;
  return data?.draftId ? { draftId: data.draftId, contentHash: data.contentHash ?? null, revision: data.revision ?? null } : undefined;
};

const proposeFiche = studioMcpWrite("propose_fiche", "Proposer une nouvelle fiche SAV",
  "Crée un BROUILLON de nouvelle fiche dans Connaissances SAV, par le même chemin que la page. Rien ne devient actif. Renvoie draftId et contentHash (sha256) à transmettre à publish_fiche, et la liste missing des compléments exigés avant publication. Administrateurs.",
  { ...ficheFields, sources: z.array(source).min(1).max(50).describe("Sources de preuve : lien https ou référence Studio (content:<id>).") },
  async (context, input, claim) => {
    if (!isAdmin(context)) return forbidden();
    return guarded(async () => {
      const delivery = chooseDelivery(input.document, input.delivery);
      const lost = await claim(); if (lost) return lost;
      return saveDraft(context, input, { mode: "new" }, delivery);
    });
  }, { receipt: draftReceipt });

const proposeFicheUpdate = studioMcpWrite("propose_fiche_update", "Proposer une nouvelle version d’une fiche SAV",
  "Crée un BROUILLON de nouvelle version d’une fiche existante (itemId de search_fiches) avec son contenu complet. La version active reste en service jusqu’à publish_fiche. Renvoie draftId et contentHash (sha256). Administrateurs.",
  { itemId: z.uuid().describe("Identifiant de la fiche (itemId)."), ...ficheFields,
    sources: z.array(source).max(50).optional().describe("Sources de preuve ; par défaut la version actuelle de la fiche (content:<itemId>).") },
  async (context, input, claim) => {
    if (!isAdmin(context)) return forbidden();
    return guarded(async () => {
      const detail = await getSavKnowledgeDetail({ itemId: input.itemId }, context.staff.email);
      if (!detail) return refused("SAV_KNOWLEDGE_FICHE_NOT_FOUND", "Fiche introuvable : utiliser search_fiches.");
      const delivery = chooseDelivery(input.document, input.delivery, detail.delivery);
      const sources = input.sources?.length ? input.sources : [{ ref: `content:${input.itemId}`, label: "Version actuelle de la fiche améliorée" }];
      const lost = await claim(); if (lost) return lost;
      return saveDraft(context, { ...input, sources }, { mode: "improve", itemId: input.itemId }, delivery);
    });
  }, { receipt: draftReceipt });

const PUBLISH_REASON = "Publication confirmée explicitement par Ugo depuis le Studio MCP.";
const publishFiche = studioMcpWrite("publish_fiche", "Publier et activer une fiche SAV",
  "Publie et active UN brouillon, uniquement sur accord explicite d’Ugo : soumission, validation, publication (indexation et embeddings) puis activation, par les mêmes fonctions que la page Connaissances. Exige draftId et contentHash renvoyés par propose ; refusé si le brouillon a changé depuis. Reprend là où un essai précédent s’est arrêté. Réservé à Ugo.",
  { draftId: z.uuid(), contentHash: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().trim().min(10).max(2000).optional().describe("Motif de validation ; par défaut l’accord d’Ugo."),
    idempotencyKey: z.uuid() },
  async (context, input, claim) => {
    if (!isAdmin(context)) return forbidden();
    return guarded(async () => {
      const actor = context.staff.email;
      assertKnowledgeUgoApproval(actor);
      const draft = await readDraft(input.draftId);
      if (!draft) return refused("SAV_KNOWLEDGE_DRAFT_NOT_FOUND", "Brouillon introuvable.");
      if (ficheContentHash(draft) !== input.contentHash) return refused("SAV_MCP_FICHE_CHANGED", "Le brouillon a changé depuis la proposition : relire avec get_fiche et faire valider le contenu actuel.");
      if (draft.status !== "draft" && !(draft.status === "submitted" && draft.candidateId)) return refused("SAV_KNOWLEDGE_DRAFT_NOT_PUBLISHABLE", "Ce brouillon n’est plus publiable.");
      if (draft.status === "draft") {
        const preview = await previewSavKnowledgeProposal(draft.id, actor);
        if (preview.missing.length) return refused("KNOWLEDGE_PROPOSAL_INCOMPLETE", "Compléments exigés avant publication : rien n’a été publié.", { missing: preview.missing });
      }
      const lost = await claim(); if (lost) return lost;
      const steps: string[] = [];
      try { return await publishChain(draft, input.reason ?? PUBLISH_REASON, actor, steps); }
      catch (error) {
        const refusal = knowledgeRefusal(error); if (!refusal) throw error;
        // Each step commits on its own: the ones done stay, a new call (new key) resumes after them.
        return { ...refusal, message: `${refusal.message} Étapes déjà faites : ${steps.join(", ") || "aucune"} ; relire get_fiche, un nouvel essai avec une nouvelle clé reprend après elles.`, data: { steps } };
      }
    });
  }, { receipt: result => { const data = result.data as { itemId?: string; versionId?: string } | undefined; return data?.itemId ? { itemId: data.itemId, versionId: data.versionId ?? null } : undefined; } });

async function publishChain(draft: DraftRow, reason: string, actor: string, steps: string[]): Promise<StudioMcpResult> {
  // 1. Submission, as « Soumettre » (returns the existing candidate when already submitted).
  let candidate;
  if (draft.status === "draft") {
    const preview = await previewSavKnowledgeProposal(draft.id, actor);
    candidate = await submitSavKnowledgeProposal({ draftId: draft.id, snapshot: preview.snapshot }, actor);
    steps.push("submitted");
  } else [candidate] = await requireDb().select().from(knowledgeProjectionCandidates).where(eq(knowledgeProjectionCandidates.id, draft.candidateId!));
  if (!candidate) return refused("KNOWLEDGE_CANDIDATE_NOT_FOUND", knowledgeErrorMessage("KNOWLEDGE_CANDIDATE_NOT_FOUND"));
  // 2. Review, as « Valider » on the submitted document, unchanged.
  if (["pending", "needs_completion"].includes(candidate.status)) {
    const review = await previewSavKnowledgeReview(candidate.id, actor);
    candidate = await reviewSavKnowledgeProposal({ candidateId: candidate.id, expectedRevisionId: candidate.revisionId, snapshot: review.snapshot, decision: "approve", reason }, actor);
    steps.push("approved");
  }
  if (candidate.status !== "approved" || !candidate.targetItemId || !candidate.materializedVersionId) return refused("KNOWLEDGE_CANDIDATE_NOT_REVIEWABLE", "La proposition n’est pas validée (écartée ou remplacée) : rien n’a été publié.", { steps });
  const itemId = candidate.targetItemId, versionId = candidate.materializedVersionId;
  // 3. Publication (indexing and embeddings), as « Publier ».
  const [item] = await requireDb().select().from(contentItems).where(eq(contentItems.id, itemId));
  if (item?.publishedVersionId !== versionId || item.status !== "published") {
    await publishSavKnowledgeVersion({ itemId, expectedVersionId: versionId }, actor).catch((error: unknown) => { refresh(); throw error; });
    steps.push("published");
  }
  // 4. Activation, as « Activer » : the previous active version stays live until this point.
  const [active] = await requireDb().select().from(savKnowledgeActivations).where(eq(savKnowledgeActivations.itemId, itemId));
  const [current] = await requireDb().select().from(contentItems).where(eq(contentItems.id, itemId));
  if (active?.versionId !== versionId || !current?.aiEnabled) {
    await activateSavKnowledgeVersion({ itemId, expectedPublishedVersionId: versionId, expectedActiveVersionId: active?.versionId ?? null }, actor);
    steps.push("activated");
  }
  refresh();
  return done(steps.length ? "Fiche publiée et active pour l’agent SAV." : "Fiche déjà publiée et active.", { itemId, versionId, previousActiveVersionId: active?.versionId === versionId ? null : active?.versionId ?? null, steps });
}

const searchFiches = { name: "search_fiches", title: "Rechercher des fiches SAV", write: false,
  description: "Recherche par texte dans Connaissances SAV, comme la page : tab production (fiches actives) ou proposals (brouillons et propositions en cours). Renvoie id, itemId, draftId, titre, statut, version et dernière mise à jour. Administrateurs.",
  input: z.object({ query: z.string().max(200).default(""), tab: z.enum(["production", "proposals"]).default("production"), page: z.number().int().min(1).max(1000).default(1) }).strict(),
  async run(context: StudioMcpContext, input: { query: string; tab: "production" | "proposals"; page: number }) {
    if (!isAdmin(context)) return forbidden();
    return guarded(async () => {
      const result = await paginateSavKnowledge({ tab: input.tab, q: input.query, page: input.page, pageSize: 20 });
      return done("OK", { total: result.total, page: result.page, pageSize: result.pageSize, rows: result.rows.map(row => ({ id: row.id, kind: row.kind, itemId: row.itemId, draftId: row.draftId,
        candidateId: row.candidateId, title: row.title, status: row.state, statusLabel: knowledgeState(row.state), version: row.version, updatedAt: row.updatedAt.toISOString(),
        activeVersionId: row.activeVersionId, hasPendingUpdate: row.hasPendingUpdate })) });
    });
  } };

const getFiche = { name: "get_fiche", title: "Lire une fiche SAV", write: false,
  description: "Contenu complet d’une fiche : version active (texte et document) et brouillons ouverts (document, sources, motif, contentHash, compléments manquants). Donner itemId, ou draftId pour un brouillon seul. Administrateurs.",
  input: z.object({ itemId: z.uuid().optional(), draftId: z.uuid().optional() }).strict(),
  async run(context: StudioMcpContext, input: { itemId?: string; draftId?: string }) {
    if (!isAdmin(context)) return forbidden();
    if (Boolean(input.itemId) === Boolean(input.draftId)) return refused("SAV_MCP_INVALID_INPUT", "Donner itemId ou draftId, pas les deux.");
    return guarded(async () => {
      const actor = context.staff.email;
      const draftView = async (id: string) => {
        const row = await readDraft(id);
        if (!row) return null;
        const detail = row.status === "draft" ? await getSavKnowledgeDetail({ draftId: id }, actor) : null;
        return { draftId: row.id, status: row.status, revision: row.revision, mode: row.mode, targetItemId: row.targetItemId, title: row.title, document: row.document, sources: row.sources,
          reason: row.reason, delivery: detail?.draft?.delivery ?? null, contentHash: ficheContentHash(row), missing: detail?.missing ?? [], createdBy: row.createdBy, updatedAt: row.updatedAt.toISOString() };
      };
      if (input.draftId) {
        const draft = await draftView(input.draftId);
        return draft ? done("OK", { draft }) : refused("SAV_KNOWLEDGE_DRAFT_NOT_FOUND", "Brouillon introuvable.");
      }
      const detail = await getSavKnowledgeDetail({ itemId: input.itemId }, actor);
      if (!detail) return refused("SAV_KNOWLEDGE_FICHE_NOT_FOUND", "Fiche introuvable : utiliser search_fiches.");
      const openDrafts = (await requireDb().select().from(savKnowledgeProposalDrafts).where(eq(savKnowledgeProposalDrafts.targetItemId, input.itemId!))).filter(row => row.status === "draft");
      return done("OK", { itemId: input.itemId, title: detail.row.title, status: detail.row.state, statusLabel: knowledgeState(detail.row.state),
        active: detail.activeVersion ? { versionId: detail.activeVersion.id, version: detail.activeVersion.version, title: detail.activeVersion.title, body: detail.activeVersion.body,
          document: detail.document, delivery: detail.delivery?.mode ?? null, activatedFrom: detail.activeVersion.createdAt.toISOString() } : null,
        sources: detail.sources, alerts: detail.alerts,
        drafts: (await Promise.all(openDrafts.map(row => draftView(row.id)))).filter(Boolean),
        pending: detail.relatedWork.filter(work => work.kind === "candidate").map(work => ({ candidateId: work.candidateId, status: work.state, statusLabel: knowledgeState(work.state), updatedAt: work.updatedAt.toISOString() })) });
    });
  } };

export const studioMcpKnowledgeReadTools = [searchFiches, getFiche] as unknown as StudioMcpTool[];
export const studioMcpKnowledgeWriteTools: StudioMcpTool[] = [proposeFiche, proposeFicheUpdate, publishFiche];
