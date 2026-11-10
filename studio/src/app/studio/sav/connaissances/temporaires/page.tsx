import Link from "next/link";
import { requireSavStaff } from "@/lib/sav/auth";
import { listTemporaryIncidentPreview } from "@/lib/knowledge/temporary-incidents-read";
import { formatParisDateTime } from "@/lib/paris-date";
import { TemporaryIncidentTable } from "./temporary-incident-table";
import { TemporaryIncidentForm } from "./temporary-incident-form";
import styles from "../workspace.module.css";

export const dynamic = "force-dynamic";

/** SAV-79 preview and proposal draft. No runtime use, approval or activation. */
export default async function TemporaryIncidentsPage() {
  await requireSavStaff();
  const rows = await listTemporaryIncidentPreview();
  return (
    <main className={styles.workspace}>
      <p><Link href="/studio/sav/connaissances">← Connaissances SAV</Link></p>
      <h1>Incidents temporaires</h1>
      <TemporaryIncidentForm />
      <TemporaryIncidentTable rows={rows} formatDate={formatParisDateTime} />
    </main>
  );
}
