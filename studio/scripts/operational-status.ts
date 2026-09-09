import "dotenv/config";

import { and, eq, lt, sql } from "drizzle-orm";
import { closeDb, requireDb } from "../src/db/client";
import {
  evaluationRuns,
  savActions,
  savGmailQuarantine,
  savMessages,
  savPilotItems,
  savWebhookReceipts,
} from "../src/db/schema";
import { savAutomationMode } from "../src/lib/sav/config";
import { getSavAutonomyGate } from "../src/lib/sav/promotion";
import { getTrainingReconciliationCandidates } from "../src/lib/training";

const db = requireDb();

try {
  const now = new Date();
  const [receiptCounts, quarantineCount, expiredEvaluations, messageDuplicates, actionDuplicates, analysisCounts, actionCounts, stalePilotItems, autonomyGate, trainingCandidates] = await Promise.all([
    db.select({
      pending: sql<number>`count(*) filter (where ${savWebhookReceipts.status} in ('pending', 'processing'))::int`,
      failed: sql<number>`count(*) filter (where ${savWebhookReceipts.status} = 'failed')::int`,
      processed: sql<number>`count(*) filter (where ${savWebhookReceipts.status} = 'processed')::int`,
    }).from(savWebhookReceipts).where(eq(savWebhookReceipts.provider, "gmail")),
    db.select({ count: sql<number>`count(*)::int` }).from(savGmailQuarantine).where(eq(savGmailQuarantine.status, "quarantined")),
    db.select({ count: sql<number>`count(*)::int` }).from(evaluationRuns).where(and(
      eq(evaluationRuns.status, "running"),
      lt(evaluationRuns.expiresAt, now),
    )),
    db.select({
      count: sql<number>`(
        select count(*)::int from (
          select mailbox_id, gmail_message_id
          from sav.messages
          where gmail_message_id is not null
          group by mailbox_id, gmail_message_id
          having count(*) > 1
        ) duplicate_messages
      )`,
    }).from(savMessages).limit(1),
    db.select({
      count: sql<number>`(
        select count(*)::int from (
          select idempotency_key
          from sav.actions
          group by idempotency_key
          having count(*) > 1
        ) duplicate_actions
      )`,
    }).from(savActions).limit(1),
    db.select({
      pending: sql<number>`count(*) filter (where ${savMessages.analysisStatus} in ('pending', 'processing'))::int`,
      failed: sql<number>`count(*) filter (where ${savMessages.analysisStatus} = 'failed')::int`,
    }).from(savMessages),
    db.select({
      retryScheduled: sql<number>`count(*) filter (where ${savActions.status} = 'pending' and ${savActions.scheduledAt} is not null)::int`,
      failed: sql<number>`count(*) filter (where ${savActions.status} = 'failed')::int`,
    }).from(savActions),
    db.select({ count: sql<number>`count(*)::int` }).from(savPilotItems).where(and(
      eq(savPilotItems.status, "processing"), lt(savPilotItems.updatedAt, new Date(now.getTime() - 10 * 60_000)),
    )),
    getSavAutonomyGate(),
    getTrainingReconciliationCandidates(now),
  ]);

  const report = {
    checkedAt: now.toISOString(),
    savModeIsShadow: savAutomationMode() === "shadow",
    gmail: {
      pending: receiptCounts[0]?.pending ?? 0,
      failed: receiptCounts[0]?.failed ?? 0,
      processed: receiptCounts[0]?.processed ?? 0,
      quarantined: quarantineCount[0]?.count ?? 0,
      duplicateMessages: messageDuplicates[0]?.count ?? 0,
      duplicateActions: actionDuplicates[0]?.count ?? 0,
    },
    analysis: analysisCounts[0] ?? { pending: 0, failed: 0 },
    actions: actionCounts[0] ?? { retryScheduled: 0, failed: 0 },
    pilot: { staleProcessing: stalePilotItems[0]?.count ?? 0 },
    autonomy: autonomyGate,
    trainings: {
      recoverable: trainingCandidates.recoverable.length,
      incomplete: trainingCandidates.incomplete.length,
    },
    evaluations: {
      expiredRunning: expiredEvaluations[0]?.count ?? 0,
    },
  };
  console.log(JSON.stringify(report, null, 2));
  if (process.argv.includes("--strict") && (
    (receiptCounts[0]?.failed ?? 0) > 0
    || (quarantineCount[0]?.count ?? 0) > 0
    || (analysisCounts[0]?.failed ?? 0) > 0
    || (actionCounts[0]?.failed ?? 0) > 0
    || (stalePilotItems[0]?.count ?? 0) > 0
    || (messageDuplicates[0]?.count ?? 0) > 0
    || (actionDuplicates[0]?.count ?? 0) > 0
  )) process.exitCode = 1;
} finally {
  await closeDb();
}
