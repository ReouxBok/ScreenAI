import {
  analyzePilotItemStep,
  finalizePilotBatchStep,
  loadPendingPilotItemsStep,
  syncPilotHubspotActionsStep,
} from "./steps";

export const SAV_PILOT_WORKFLOW_CONCURRENCY = 3;

export function chunkPilotItemIds(itemIds: string[], size = SAV_PILOT_WORKFLOW_CONCURRENCY) {
  const safeSize = Math.max(1, Math.floor(size));
  const chunks: string[][] = [];
  for (let index = 0; index < itemIds.length; index += safeSize) chunks.push(itemIds.slice(index, index + safeSize));
  return chunks;
}

export async function analyzeSavPilotBatchWorkflow(batchId: string) {
  "use workflow";
  console.info("sav_pilot_workflow_started", { batchId });
  const itemIds = await loadPendingPilotItemsStep(batchId);
  const results = [];
  for (const itemGroup of chunkPilotItemIds(itemIds)) {
    results.push(...await Promise.all(itemGroup.map((itemId) => analyzePilotItemStep(batchId, itemId))));
  }
  const batch = await finalizePilotBatchStep(batchId);
  const hubspot = await syncPilotHubspotActionsStep(batchId);
  console.info("sav_pilot_workflow_finished", { batchId, analyzed: results.length, hubspotActions: hubspot.processed.length });
  return { batchId, analyzed: results.length, batch, hubspotActions: hubspot.processed.length };
}
