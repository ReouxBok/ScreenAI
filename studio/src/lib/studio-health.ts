import "server-only";

import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import {
  contentChunks,
  contentItems,
  evaluationRuns,
  savActions,
  savGmailQuarantine,
  savMailboxes,
  savWebhookReceipts,
} from "@/db/schema";
import { GEMINI_EMBEDDING_MODEL, probeEmbedding } from "./embeddings";
import { savAutomationMode } from "./sav/config";
import { getTrainingReconciliationCandidates } from "./training";

export type StudioHealthLevel = "healthy" | "warning" | "error";
export type StudioHealthCheck = {
  key: string;
  label: string;
  level: StudioHealthLevel;
  summary: string;
  detail: string;
};

async function proxyHealth(): Promise<StudioHealthCheck> {
  const endpoint = process.env.CHARLY_PROXY_HEALTH_URL || "https://limova-proxy-479c7fb78ccf.herokuapp.com/healthz";
  const startedAt = performance.now();
  try {
    const response = await fetch(endpoint, { cache: "no-store", signal: AbortSignal.timeout(4_000) });
    return {
      key: "proxy",
      label: "Proxy Charly",
      level: response.ok ? "healthy" : "error",
      summary: response.ok ? "Disponible" : `HTTP ${response.status}`,
      detail: `${Math.round(performance.now() - startedAt)} ms · vérification sans donnée client`,
    };
  } catch (error) {
    return {
      key: "proxy",
      label: "Proxy Charly",
      level: "error",
      summary: "Injoignable",
      detail: `${error instanceof Error ? error.name : "NETWORK_ERROR"} · ${Math.round(performance.now() - startedAt)} ms`,
    };
  }
}

export async function getStudioHealth(options: { probeKnowledge?: boolean } = {}) {
  const db = requireDb();
  const now = new Date();
  const [mailboxRows, receiptCounts, quarantineCount, hubspotFailures, knowledgeCounts, expiredEvaluations, trainingCandidates, proxy] = await Promise.all([
    db.select().from(savMailboxes).where(eq(savMailboxes.active, true)),
    db.select({
      pending: sql<number>`count(*) filter (where ${savWebhookReceipts.status} in ('pending', 'processing'))::int`,
      failed: sql<number>`count(*) filter (where ${savWebhookReceipts.status} = 'failed')::int`,
    }).from(savWebhookReceipts).where(eq(savWebhookReceipts.provider, "gmail")),
    db.select({ count: sql<number>`count(*)::int` }).from(savGmailQuarantine).where(eq(savGmailQuarantine.status, "quarantined")),
    db.select({ count: sql<number>`count(*)::int` }).from(savActions).where(and(
      eq(savActions.status, "failed"),
      inArray(savActions.kind, ["create_ticket", "link_ticket", "log_email", "create_note", "update_ticket_status"]),
    )),
    db.select({
      published: sql<number>`count(distinct ${contentItems.id}) filter (where ${contentItems.publishedVersionId} is not null and ${contentItems.aiEnabled} = true)::int`,
      chunks: sql<number>`count(${contentChunks.id}) filter (where ${contentItems.publishedVersionId} is not null and ${contentItems.aiEnabled} = true and ${contentChunks.versionId} = ${contentItems.publishedVersionId})::int`,
    }).from(contentItems).leftJoin(contentChunks, eq(contentChunks.itemId, contentItems.id)),
    db.select({ count: sql<number>`count(*)::int` }).from(evaluationRuns).where(and(
      eq(evaluationRuns.status, "running"),
      lt(evaluationRuns.expiresAt, now),
    )),
    getTrainingReconciliationCandidates(now),
    proxyHealth(),
  ]);

  const receipts = receiptCounts[0] ?? { pending: 0, failed: 0 };
  const quarantined = quarantineCount[0]?.count ?? 0;
  const mailbox = mailboxRows[0];
  const watchExpiring = !mailbox?.watchExpiration || mailbox.watchExpiration.getTime() < now.getTime() + 12 * 60 * 60 * 1_000;
  const gmailLevel: StudioHealthLevel = receipts.failed || quarantined ? "error" : receipts.pending || watchExpiring ? "warning" : "healthy";
  const automationMode = savAutomationMode();
  const externalWriteSafe = automationMode === "shadow";
  const knowledge = knowledgeCounts[0] ?? { published: 0, chunks: 0 };

  let embedding: StudioHealthCheck = {
    key: "embedding",
    label: "Embedding Gemini",
    level: "warning",
    summary: options.probeKnowledge ? "Test non exécuté" : "À tester manuellement",
    detail: `${GEMINI_EMBEDDING_MODEL} · le test utilise une phrase technique fixe`,
  };
  if (options.probeKnowledge) {
    try {
      const result = await probeEmbedding("extension");
      embedding = { key: "embedding", label: "Embedding Gemini", level: "healthy", summary: `HTTP ${result.status}`, detail: `${result.model} · ${result.latencyMs} ms` };
    } catch (error) {
      const source = error && typeof error === "object" ? error as Record<string, unknown> : {};
      embedding = {
        key: "embedding",
        label: "Embedding Gemini",
        level: "error",
        summary: `Échec ${String(source.status ?? source.code ?? "PROVIDER_ERROR").slice(0, 80)}`,
        detail: `${GEMINI_EMBEDDING_MODEL} · aucun contenu client ni secret journalisé`,
      };
    }
  }

  const checks: StudioHealthCheck[] = [
    {
      key: "gmail",
      label: "Gmail",
      level: gmailLevel,
      summary: `${receipts.pending} en attente · ${receipts.failed} en échec · ${quarantined} en quarantaine`,
      detail: mailbox ? `Watch ${mailbox.watchStatus}${mailbox.watchExpiration ? ` jusqu’au ${mailbox.watchExpiration.toLocaleString("fr-FR")}` : " sans expiration connue"}` : "Aucune boîte active",
    },
    {
      key: "hubspot",
      label: "HubSpot",
      level: (hubspotFailures[0]?.count ?? 0) ? "error" : process.env.HUBSPOT_ACCESS_TOKEN ? "healthy" : "warning",
      summary: process.env.HUBSPOT_ACCESS_TOKEN ? `${hubspotFailures[0]?.count ?? 0} action externe en échec` : "Clé de service absente",
      detail: externalWriteSafe ? "Mode shadow : aucune écriture automatique autorisée" : `Mode ${automationMode} : écritures potentiellement actives`,
    },
    {
      key: "knowledge",
      label: "Recherche Charly",
      level: knowledge.published && !knowledge.chunks ? "error" : "healthy",
      summary: knowledge.published ? `${knowledge.published} contenu(s) IA · ${knowledge.chunks} chunk(s)` : "Base publiée vide · réponse kb_empty attendue",
      detail: "Un brouillon n’est jamais indexé avant validation et publication",
    },
    embedding,
    proxy,
    {
      key: "trainings",
      label: "Sessions tutoriels",
      level: trainingCandidates.recoverable.length || trainingCandidates.incomplete.length ? "warning" : "healthy",
      summary: `${trainingCandidates.recoverable.length} à finaliser · ${trainingCandidates.incomplete.length} à archiver`,
      detail: "Réconciliation automatique : 10 min pour une vidéo complète, 75 min pour un upload incomplet",
    },
    {
      key: "evaluations",
      label: "Évaluations",
      level: (expiredEvaluations[0]?.count ?? 0) ? "warning" : "healthy",
      summary: `${expiredEvaluations[0]?.count ?? 0} run(s) expiré(s) encore actif(s)`,
      detail: "Le réconciliateur les bascule en failed/expired avec audit",
    },
  ];
  return { checkedAt: now, checks, automationMode };
}
