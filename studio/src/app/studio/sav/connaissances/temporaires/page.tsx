import Link from "next/link";
import { requireSavStaff } from "@/lib/sav/auth";
import { listTemporaryIncidentPreview } from "@/lib/knowledge/temporary-incidents-read";
import { temporaryKnowledgeEnabled } from "@/lib/knowledge/temporary-knowledge";
import { formatParisDateTime } from "@/lib/paris-date";
import { TemporaryIncidentTable } from "./temporary-incident-table";
import { TemporaryIncidentForm } from "./temporary-incident-form";
import styles from "../workspace.module.css";

export const dynamic = "force-dynamic";

export default async function TemporaryIncidentsPage() {
  await requireSavStaff();
  const rows = await listTemporaryIncidentPreview();
  return (
    <main className={styles.workspace}>
      <p><Link href="/studio/sav/connaissances">← Connaissances SAV</Link></p>
      <h1>Incidents temporaires</h1>
      <TemporaryIncidentForm withKeywords={temporaryKnowledgeEnabled()} />
      <TemporaryIncidentTable rows={rows} formatDate={formatParisDateTime} />
    </main>
  );
}
