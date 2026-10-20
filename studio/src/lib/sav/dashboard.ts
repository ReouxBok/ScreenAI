import "server-only";
import { listSavDossierDashboardReference, type SavDashboardOptions } from "./dashboard-source";
import { measureSavDashboardRead } from "./read-metrics";
import { listSavDossierDashboardSql, savSqlDashboardEnabled } from "./dashboard-projection";
export { savDashboardTicketProgress, savDashboardLearningProgress } from "./dashboard-source";
export type { SavDashboardRow } from "./dashboard-source";

export async function listSavDossierDashboard(options: SavDashboardOptions = {}) {
  const enabled = savSqlDashboardEnabled();
  return measureSavDashboardRead(enabled ? "sql" : "reference", () => enabled ? listSavDossierDashboardSql(options) : listSavDossierDashboardReference(options));
}
