import { vi } from "vitest";

// Run the complete existing dashboard regression matrix through SQL as well.
vi.mock("./dashboard", async importOriginal => {
  const original = await importOriginal<typeof import("./dashboard")>();
  const { listSavDossierDashboardSql } = await import("./dashboard-projection");
  return { ...original, listSavDossierDashboard: listSavDossierDashboardSql };
});
import "./dashboard.test";
