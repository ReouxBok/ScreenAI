import "server-only";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savAgentRuns } from "@/db/schema";
import type { StudioHealthCheck } from "../studio-health";

type ProviderCounts = { runs: number; providerFailures: number; outputFailures: number; validationFailures: number; lastProviderFailure: string | null; lastSuccess: string | null };
/** One stable health row deduplicates repeated failures; no external notification. */
export function savProviderHealthCheck(counts: ProviderCounts): StudioHealthCheck {
  const unresolved = !!counts.lastProviderFailure && (!counts.lastSuccess || Date.parse(counts.lastProviderFailure) > Date.parse(counts.lastSuccess));
  return { key: "sav-ai-provider", label: "IA du SAV", level: unresolved ? "error" : counts.providerFailures || counts.outputFailures || counts.validationFailures || !counts.runs ? "warning" : "healthy",
    summary: !counts.runs ? "Aucun appel réel observé sur 24 h" : unresolved ? "Panne fournisseur sans analyse réussie depuis" : `${counts.providerFailures} panne(s) fournisseur sur 24 h`,
    detail: `${counts.runs} analyses réelles · ${counts.outputFailures} sortie(s) invalide(s) · ${counts.validationFailures} refus de validation. Une réussite technique ne valide pas la qualité métier.` };
}

export async function getSavProviderHealth(now = new Date()): Promise<StudioHealthCheck> {
  try {
    const [counts] = await requireDb().select({
      runs: sql<number>`count(*)::int`,
      providerFailures: sql<number>`count(*) filter (where ${savAgentRuns.errorCode} ~ '^SAV_AI_(HTTP_[1-5][0-9]{2}|TIMEOUT|GENERATION_FAILED|KEY_MISSING)$')::int`,
      outputFailures: sql<number>`count(*) filter (where ${savAgentRuns.errorCode} ~ '^SAV_AI_(INVALID_|OUTPUT_|EMPTY_)')::int`,
      validationFailures: sql<number>`count(*) filter (where ${savAgentRuns.errorCode} ~ '^SAV_(UNDERSTANDING_|REPLY_|CITATION_|UNGROUNDED_)')::int`,
      lastProviderFailure: sql<string | null>`max(${savAgentRuns.createdAt}) filter (where ${savAgentRuns.errorCode} ~ '^SAV_AI_(HTTP_[1-5][0-9]{2}|TIMEOUT|GENERATION_FAILED|KEY_MISSING)$')::text`,
      lastSuccess: sql<string | null>`max(${savAgentRuns.createdAt}) filter (where ${savAgentRuns.runtime} in ('legacy_gemini','google_adk') and ${savAgentRuns.status} = 'succeeded' and ${savAgentRuns.errorCode} is null)::text`,
    }).from(savAgentRuns).where(and(eq(savAgentRuns.dataOrigin, "real"), isNull(savAgentRuns.pilotBatchId), gte(savAgentRuns.createdAt, new Date(now.getTime() - 86_400_000)), sql`${savAgentRuns.status} <> 'shadow'`, sql`${savAgentRuns.runtime} <> 'rules'`));
    return savProviderHealthCheck(counts);
  } catch {
    return { key: "sav-ai-provider", label: "IA du SAV", level: "warning", summary: "Mesure indisponible", detail: "Impossible de lire les compteurs ; la disponibilité du fournisseur n’est pas confirmée." };
  }
}
