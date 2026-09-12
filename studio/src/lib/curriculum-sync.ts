import "server-only";

import { eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { contentItems, contentVersions, type OnboardingMetadata } from "@/db/schema";
import { curriculumSlug, LIMOVA_CURRICULUM } from "./limova-curriculum";
import { buildOperationalJourney } from "./operational-journey";
import { ensureCategories, publish, saveDraft, setContentAiEnabled } from "./workflow";

const ACTOR = "curriculum@limova.ai";
const normalized = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr").replace(/[^a-z0-9]+/g, " ").trim();
const unique = (values: unknown[], max = 50) => [...new Set(values.map(String).map((value) => value.trim()).filter(Boolean))].slice(0, max);
const objects = (value: unknown) => Array.isArray(value) ? value.filter((item): item is { condition: string; next: string } => Boolean(item && typeof item === "object" && "condition" in item && "next" in item)) : [];

function mergeMetadata(generated: OnboardingMetadata, existing?: OnboardingMetadata): OnboardingMetadata {
  if (!existing) return generated;
  const existingSuccess = existing.successCriteria?.filter((value) => !/^le parcours démontré est terminé$/i.test(value)) ?? [];
  const existingFallbacks = existing.fallbacks?.filter((value) => !/^demander une précision au membre limova$/i.test(value)) ?? [];
  return {
    ...generated,
    proposalSignals: unique([...generated.proposalSignals, ...(existing.proposalSignals ?? [])]),
    qualificationQuestions: unique([...generated.qualificationQuestions, ...(existing.qualificationQuestions ?? [])]),
    expectedPages: unique([...generated.expectedPages, ...(existing.expectedPages ?? [])]),
    successCriteria: unique([...generated.successCriteria, ...existingSuccess]),
    branches: [...objects(generated.branches), ...objects(existing.branches)].filter((branch, index, all) => all.findIndex((candidate) => candidate.condition === branch.condition && candidate.next === branch.next) === index).slice(0, 30),
    fallbacks: unique([...generated.fallbacks, ...existingFallbacks]),
    actionSteps: Array.isArray(existing.actionSteps) ? existing.actionSteps.slice(0, 50) : [],
    sourceMetadata: { ...(existing.sourceMetadata ?? {}), ...(generated.sourceMetadata ?? {}), enrichedAt: new Date().toISOString() },
  };
}

export async function syncCurriculumBatch(input: { offset: number; limit: number; publishNow: boolean }) {
  await ensureCategories();
  const db = requireDb();
  const allItems = await db.select().from(contentItems);
  const entries = LIMOVA_CURRICULUM.slice(input.offset, input.offset + input.limit);
  const results: Array<{ title: string; status: string; id?: string; error?: string }> = [];

  for (const entry of entries) {
    try {
      const slug = curriculumSlug(entry.title);
      const candidates = allItems.filter((item) => item.type === "onboarding" && (item.slug === slug || normalized(item.title) === normalized(entry.title)));
      const existingItem = candidates.sort((a, b) => Number(Boolean(b.publishedVersionId)) - Number(Boolean(a.publishedVersionId)) || a.createdAt.getTime() - b.createdAt.getTime())[0];
      const [existingVersion] = existingItem?.currentDraftVersionId
        ? await db.select().from(contentVersions).where(eq(contentVersions.id, existingItem.currentDraftVersionId)).limit(1)
        : [];
      const generated = buildOperationalJourney(entry);
      const previousBody = existingVersion?.bodyMarkdown ?? "";
      const existingMetadata = existingVersion?.metadata as OnboardingMetadata | undefined;
      const alreadyGenerated = existingMetadata?.sourceMetadata?.generatedRevision === "operational-v2";
      const preservePrevious = previousBody && !alreadyGenerated && !previousBody.includes("Ce que le code permet de préremplir");
      const bodyMarkdown = preservePrevious
        ? `${generated.bodyMarkdown}\n\n## Compléments déjà transmis par le staff\n\n${previousBody}`.slice(0, 200_000)
        : generated.bodyMarkdown;
      const metadata = mergeMetadata(generated.metadata as OnboardingMetadata, existingMetadata);
      const saved = await saveDraft({
        type: "onboarding", slug: existingItem?.slug ?? slug, locale: "fr-FR", title: entry.title,
        summary: generated.summary, categorySlug: entry.categorySlug, visibility: "charly_only",
        agentKey: entry.agentKey, ownerEmail: existingItem?.ownerEmail ?? ACTOR,
        bodyMarkdown, changeNote: "Enrichissement opérationnel généré depuis les codebases Limova", metadata,
      }, ACTOR, existingItem?.id);
      if (input.publishNow) {
        await publish(saved.item.id, ACTOR, { emergency: true, reason: "Activation du curriculum opérationnel demandé pour Charly" });
        await setContentAiEnabled(saved.item.id, true, ACTOR);
      }
      if (!existingItem) allItems.push(saved.item);
      results.push({ title: entry.title, id: saved.item.id, status: input.publishNow ? "published" : "draft" });
    } catch (error) {
      results.push({ title: entry.title, status: "failed", error: error instanceof Error ? error.message.slice(0, 300) : "unknown" });
    }
  }
  return { offset: input.offset, processed: entries.length, total: LIMOVA_CURRICULUM.length, nextOffset: input.offset + entries.length, done: input.offset + entries.length >= LIMOVA_CURRICULUM.length, results };
}
