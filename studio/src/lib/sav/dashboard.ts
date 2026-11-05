import "server-only";
import { listSavDossierDashboardReference, type SavDashboardOptions } from "./dashboard-source";
import { measureSavDashboardRead } from "./read-metrics";
import { listSavDossierDashboardSql, readSavDossierDashboardSqlReadOnly, savSqlDashboardEnabled, type SavDashboardReadOnlyResult } from "./dashboard-projection";
export type { SavDashboardReadOnlyResult } from "./dashboard-projection";
export { savDashboardTicketProgress, savDashboardLearningProgress } from "./dashboard-source";
export type { SavDashboardRow } from "./dashboard-source";

export async function listSavDossierDashboard(options: SavDashboardOptions = {}) {
  const enabled = savSqlDashboardEnabled();
  return measureSavDashboardRead(enabled ? "sql" : "reference", () => enabled ? listSavDossierDashboardSql(options) : listSavDossierDashboardReference(options));
}

/** Same switch as `listSavDossierDashboard`, without any repair: opening the list writes nothing. On the SQL path a stale or missing projection answers
 * `{ pending: true }` (the cron step `dashboard_projection` refreshes it); the reference path was already one read-only transaction. */
export async function listSavDossierDashboardReadOnly(options: SavDashboardOptions = {}): Promise<SavDashboardReadOnlyResult> {
  return measureSavDashboardRead(savSqlDashboardEnabled() ? "sql" : "reference", async (): Promise<SavDashboardReadOnlyResult> => savSqlDashboardEnabled()
    ? readSavDossierDashboardSqlReadOnly(options)
    : { pending: false, data: await listSavDossierDashboardReference(options) });
}
