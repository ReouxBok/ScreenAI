import Link from "next/link";
import { requireSavStaff } from "@/lib/sav/auth";
import { canManageSavPlaybook } from "@/lib/sav/playbook-contract";
import { listSavDiagnosticEnrichment } from "@/lib/knowledge/diagnostic-enrichment";
import { EnrichmentButton } from "./prepare-button";
export const dynamic = "force-dynamic";
export default async function DiagnosticEnrichmentPage({ searchParams }: { searchParams: Promise<{ after?: string }> }) {
  const staff = await requireSavStaff();
  const query = await searchParams;
  const after = query.after && /^[a-f0-9-]{36}$/.test(query.after) ? query.after : undefined;
  const page = await listSavDiagnosticEnrichment(after);
  return <div className="stack"><Link href="/studio/sav/connaissances">← Connaissances</Link><h1>Enrichir toutes les fiches actives</h1>
    <p>Préparer des brouillons à partir des étapes et résultats déjà documentés. Aucune question ni branche n’est déduite de l’ordre des étapes. Chaque brouillon doit être qualifié comme procédure client, diagnostic explicite ou consigne interne pendant la revue. Les versions actives restent utilisées jusqu’à validation, publication et activation distinctes.</p>
    <EnrichmentButton after={after} canManage={canManageSavPlaybook(staff.email)}/>
    <ul>{page.rows.map(({ item, version }) => <li key={item.id}><Link href={`/studio/sav/connaissances/${item.id}?kind=item`}>{item.title}</Link> · version {version.version}</li>)}</ul>
    {page.next && <Link href={`/studio/sav/connaissances/diagnostic?after=${page.next}`}>Fiches suivantes →</Link>}
  </div>;
}
