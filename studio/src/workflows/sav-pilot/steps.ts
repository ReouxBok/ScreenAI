import "server-only";

import { processPendingPilotHubspotActions } from "@/lib/sav/hubspot";
import {
  finalizeSavPilotBatchIfReady,
  listPendingSavPilotItemIds,
  processSavPilotItem,
} from "@/lib/sav/service";

export async function loadPendingPilotItemsStep(batchId: string) {
  "use step";
  console.info("sav_pilot_workflow_items_loading", { batchId });
  const itemIds = await listPendingSavPilotItemIds(batchId);
  console.info("sav_pilot_workflow_items_loaded", { batchId, count: itemIds.length });
  return itemIds;
}

export async function analyzePilotItemStep(batchId: string, itemId: string) {
  "use step";
  console.info("sav_pilot_workflow_item_started", { batchId, itemId });
  const result = await processSavPilotItem(itemId);
  console.info("sav_pilot_workflow_item_finished", { batchId, itemId, status: result?.status ?? "skipped" });
  return result;
}

// The service already records a failed analysis on the pilot item. Retrying the
// same claimed item immediately would not be useful; the cron remains the
// recovery path for work that was never claimed.
analyzePilotItemStep.maxRetries = 0;

export async function finalizePilotBatchStep(batchId: string) {
  "use step";
  const result = await finalizeSavPilotBatchIfReady(batchId);
  console.info("sav_pilot_workflow_batch_finalized", result);
  return result;
}

export async function syncPilotHubspotActionsStep(batchId: string) {
  "use step";
  console.info("sav_pilot_workflow_hubspot_started", { batchId });
  const result = await processPendingPilotHubspotActions(batchId, 100);
  console.info("sav_pilot_workflow_hubspot_finished", { batchId, processed: result.processed.length });
  return result;
}
