import "server-only";
import { requireDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { collectLatestSavDossierContext } from "@/lib/sav/dossier-context";
import { processPendingHubspotActions } from "@/lib/sav/hubspot";

export async function executeSavTicketCommandStep(actionId: string) {
  "use step";
  // The worker owns claiming, durable dispatch markers and safe retry scheduling.
  return processPendingHubspotActions(1, actionId);
}
executeSavTicketCommandStep.maxRetries = 0;

export async function refreshSavContextStep(threadId: string, requestId: string, actorEmail: string) {
  "use step";
  let status: "completed" | "failed" = "completed";
  try {
    const context = await collectLatestSavDossierContext(threadId);
    if (context.crm.status !== "ready") status = "failed";
  } catch { status = "failed"; }
  await requireDb().insert(auditLogs).values({ actorEmail, action: `sav_context_refresh_${status}`, entityType: "sav_context_refresh", entityId: requestId, technicalMetadata: { threadId } });
  return { status };
}
refreshSavContextStep.maxRetries = 1;
