import "server-only";
import { and, eq, ne, or } from "drizzle-orm";
import { requireDb } from "@/db";
import { contentItems, contentVersions, knowledgeProjectionCandidates } from "@/db/schema";
import { parseContentInput } from "@/lib/content";
import { savContentHash } from "@/lib/sav/crypto";
import { assertSavActor } from "@/lib/sav/access";
import { registerCanonicalKnowledge } from "./families";
import { storeCandidate } from "./candidates";
import { savProjectionBody } from "./conversion";
import { compareKnowledge, parseHubspotKnowledgeImport, type KnowledgeComparisonEntry } from "./hubspot-input";

type DbReader = Pick<ReturnType<typeof requireDb>, "select">;
export async function knowledgeComparisonInventory(db: DbReader = requireDb()): Promise<KnowledgeComparisonEntry[]> {
  // Compare published AND draft articles, including existing common/Charly knowledge.
  const articles = await db.select({ item: contentItems, version: contentVersions }).from(contentItems)
    .innerJoin(contentVersions, and(eq(contentVersions.itemId, contentItems.id), or(eq(contentVersions.id, contentItems.currentDraftVersionId), eq(contentVersions.id, contentItems.publishedVersionId))))
    .where(and(eq(contentItems.type, "article"), ne(contentItems.status, "archived")));
  const candidates = await db.select().from(knowledgeProjectionCandidates).where(and(eq(knowledgeProjectionCandidates.targetSurface, "sav"), eq(knowledgeProjectionCandidates.status, "pending")));
  return [...articles.map(({ item, version }) => ({ ref: `content:${item.id}`, versionId: version.id, title: item.title, body: version.bodyMarkdown, agentKey: item.agentKey })),
    ...candidates.map((candidate) => {
      const input = parseContentInput(candidate.proposedInput);
      return { ref: `candidate:${candidate.id}`, versionId: candidate.revisionId, title: input.title, body: input.bodyMarkdown, agentKey: "sav" };
    })].sort((a, b) => `${a.ref}:${a.versionId}`.localeCompare(`${b.ref}:${b.versionId}`));
}
export function hubspotComparison(candidate: { id: string; proposedInput: unknown }, inventory: KnowledgeComparisonEntry[]) {
  const input = parseContentInput(candidate.proposedInput);
  const others = inventory.filter((entry) => entry.ref !== `candidate:${candidate.id}`);
  const findings = compareKnowledge({ title: input.title, body: input.bodyMarkdown }, others);
  // Bind the acknowledgment to all compared versions, including unmatched records.
  return { snapshot: savContentHash({ candidateId: candidate.id, input, inventory: others }), findings, compared: others.length };
}

/** Private upload -> pending Studio candidates only. No network/model/publication effects. */
export async function importHubspotKnowledge(text: string, actorEmail: string) {
  assertSavActor(actorEmail);
  const input = parseHubspotKnowledgeImport(text);
  // Validate every projection before the first write. A failed DB attempt is safely retried.
  const prepared = input.entries.map((entry) => ({ entry, projection: parseContentInput({
    type: "article", slug: `sav-hubspot-${input.namespace}-${entry.externalId}`, locale: entry.document.locale,
    title: entry.title, summary: entry.document.objective, categorySlug: "depannage", visibility: "charly_only", agentKey: "sav", ownerEmail: actorEmail,
    bodyMarkdown: savProjectionBody(entry.document), changeNote: "Import privé HubSpot proposé ; revue et publication Ugo requises", metadata: {
      intents: [entry.title, ...(entry.document.supportContext?.symptoms ?? [])], limovaPaths: [], prerequisites: entry.document.prerequisites,
      expectedResult: entry.document.expectedResult, troubleshooting: entry.document.escalation, semanticSteps: entry.document.steps,
      sourceMetadata: { importKind: "hubspot", externalId: entry.externalId, namespace: input.namespace },
      resolution: { symptoms: entry.document.supportContext?.symptoms ?? [entry.title], steps: entry.document.steps.map((step) => step.instruction),
        exceptions: entry.document.exceptions, escalation: entry.document.escalation, productVersion: entry.document.productVersion,
        ...(entry.document.validUntil ? { validUntil: entry.document.validUntil } : {}), supersedes: [], conflictsWith: [] },
    },
  }) }));
  if (prepared.some(({ projection }) => projection.bodyMarkdown.length > 12_000)) throw new Error("HUBSPOT_PROCEDURE_TOO_LONG");
  const results = [];
  for (const { entry, projection } of prepared) {
    const ref = `hubspot:${input.namespace}:${entry.externalId}`;
    const registered = await registerCanonicalKnowledge({ canonicalKey: ref, title: entry.title, document: entry.document,
      source: { ref, hash: savContentHash(entry), evidence: { importKind: "hubspot", ...entry.provenance } },
    }, actorEmail);
    const proposedInput = parseContentInput({ ...projection, metadata: { ...projection.metadata, sourceMetadata: {
      ...projection.metadata.sourceMetadata, canonicalFamilyId: registered.family.id, canonicalRevisionId: registered.revision.id, canonicalObjective: entry.document.objective,
    } } });
    results.push(await storeCandidate({ familyId: registered.family.id, revisionId: registered.revision.id, sourceId: registered.source.id,
      targetSurface: "sav", status: "pending", explanation: "Fiche issue des échanges HubSpot : vérifier les sources, les diagnostics et la comparaison avant validation. Aucune activation automatique.", proposedInput,
    }, actorEmail));
  }
  return { processed: results.length, candidateIds: results.flatMap((result) => result.candidate ? [result.candidate.id] : []), alreadyProjected: results.filter((result) => result.disposition === "already_projected").length };
}
