import "server-only";
import { and, asc, eq, gt } from "drizzle-orm";
import { requireDb } from "@/db";
import { contentItems, contentVersions, knowledgeFamilyRevisions, savKnowledgeActivations, savKnowledgeProposalDrafts } from "@/db/schema";
import { defaultSavPlaybook, assertSavPlaybookActor } from "@/lib/sav/playbook-contract";
import { articleMetadataSchema } from "@/lib/content";
import { canonicalKnowledgeSchema, type CanonicalKnowledge } from "./contracts";
import { canonicalFromSav } from "./conversion";
import { saveSavKnowledgeProposal } from "./proposals";

/** Structure only existing evidence. No model call, invented result or verifiedAt refresh. */
export function enrichSavDiagnosticDocument(document: CanonicalKnowledge): CanonicalKnowledge {
  if (document.diagnostic) return document;
  const patterns: Array<[string, RegExp]> = [
    ["page_url", /\burl\b|adresse.*page|page.*address/i],
    ["registration_email", /e.?mail|adresse.*inscri|account.*address/i],
    ["integration_name", /(?:quelle|nom|which|name).*int[eé]gration|(?:quel|which).*connecteur/i],
    ["connection_mode", /mode.*connexion|connection.*mode|api.*oauth/i],
    ["error_message", /message.*erreur|error.*message|code.*erreur/i],
    ["phone_number", /num[eé]ro.*t[eé]l[eé]phone|phone.*number/i],
    ["publication_date", /date.*publication|quand.*publi|publication.*date/i],
  ];
  const mapped = new Map<string, { key: string; label: string; question: string; questionEn?: string; requiredFor: string[] }>();
  for (const question of document.supportContext?.diagnosticQuestions ?? []) {
    const matches = patterns.filter(([, pattern]) => pattern.test(question));
    if (matches.length !== 1 || mapped.has(matches[0][0])) continue;
    const key = matches[0][0], label = defaultSavPlaybook.facts.find(f => f.key === key)!.label;
    mapped.set(key, { key, label, question, ...(document.locale === "en-US" ? { questionEn: question } : {}), requiredFor: document.steps.map(step => step.id) });
  }
  return canonicalKnowledgeSchema.parse({ ...document, diagnostic: {
    requiredFacts: [...mapped.values()], knownCauses: [],
    checks: document.steps.map((step, index) => ({ id: step.id, evidenceStepId: step.id,
      instruction: step.instruction, expectedResult: step.expectedResult,
      ifExpected: document.steps[index + 1]?.id ?? null, ifNot: null, prerequisites: [] })),
  } });
}
export async function listSavDiagnosticEnrichment(afterId?: string) {
  const db = requireDb();
  const rows = await db.select({ item: contentItems, version: contentVersions }).from(contentItems)
    .innerJoin(savKnowledgeActivations, eq(savKnowledgeActivations.itemId, contentItems.id))
    .innerJoin(contentVersions, and(eq(contentVersions.id, savKnowledgeActivations.versionId), eq(contentVersions.itemId, contentItems.id)))
    .where(and(eq(contentItems.agentKey, "sav"), eq(contentItems.type, "article"), eq(contentItems.aiEnabled, true), afterId ? gt(contentItems.id, afterId) : undefined))
    .orderBy(asc(contentItems.id)).limit(21);
  return { rows: rows.slice(0, 20), next: rows.length > 20 ? rows[19].item.id : null };
}
export async function prepareSavDiagnosticEnrichment(input: { afterId?: string }, actorEmail: string) {
  assertSavPlaybookActor(actorEmail);
  const db = requireDb();
  const page = await listSavDiagnosticEnrichment(input.afterId);
  const results: Array<{ itemId: string; title: string; status: "prepared" | "preserved" | "review_required"; draftId?: string }> = [];
  for (const { item, version } of page.rows) {
    const [existing] = await db.select().from(savKnowledgeProposalDrafts).where(and(eq(savKnowledgeProposalDrafts.targetItemId, item.id), eq(savKnowledgeProposalDrafts.status, "draft"))).limit(1);
    if (existing) { results.push({ itemId: item.id, title: item.title, status: "preserved", draftId: existing.id }); continue; }
    // An unpublished update must not be silently used as the proof of the active procedure.
    if (item.status === "archived" || item.publishedVersionId !== version.id || item.currentDraftVersionId && item.currentDraftVersionId !== version.id) {
      results.push({ itemId: item.id, title: item.title, status: "review_required" }); continue;
    }
    const metadata = articleMetadataSchema.parse(version.metadata);
    const revisionId = metadata.sourceMetadata?.canonicalRevisionId;
    const [revision] = typeof revisionId === "string" ? await db.select().from(knowledgeFamilyRevisions).where(eq(knowledgeFamilyRevisions.id, revisionId)) : [];
    const document = enrichSavDiagnosticDocument(revision ? canonicalKnowledgeSchema.parse(revision.document)
      : canonicalFromSav(`content:${item.id}`, metadata, item.locale, item.title).document);
    const draft = await saveSavKnowledgeProposal({ preparationKind: "diagnostic_enrichment", mode: "improve", targetItemId: item.id, title: item.title, document,
      sources: [{ ref: `content:${item.id}:${version.id}`, label: "Version active source conservée" }],
      reason: "Structurer les contrôles existants pour le diagnostic SAV. Questions manquantes, conditions et branches à qualifier lors de la revue ; aucune cause ou procédure nouvelle inventée." }, actorEmail);
    results.push({ itemId: item.id, title: item.title, status: "prepared", draftId: draft.id });
  }
  return { results, next: page.next };
}
