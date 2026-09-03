import Link from "next/link";
import { Activity, CheckCircle2, CircleAlert, RefreshCw, ShieldCheck } from "lucide-react";
import { requireStaff } from "@/lib/auth";
import { getStudioHealth } from "@/lib/studio-health";

export const dynamic = "force-dynamic";

export default async function StudioHealthPage({ searchParams }: { searchParams: Promise<{ probe?: string }> }) {
  await requireStaff("admin");
  const { probe } = await searchParams;
  const health = await getStudioHealth({ probeKnowledge: probe === "embedding" });
  const errors = health.checks.filter(({ level }) => level === "error").length;
  const warnings = health.checks.filter(({ level }) => level === "warning").length;

  return <div className="health-page">
    <section className={`health-hero ${errors ? "error" : warnings ? "warning" : "healthy"}`}>
      <div><span className="eyebrow">Supervision interne</span><h1>Santé du Studio</h1><p>Une vue réservée aux administrateurs pour repérer les blocages avant qu’ils n’affectent les tutoriels, la recherche ou le SAV.</p></div>
      <div className="health-score"><Activity size={24}/><strong>{errors ? `${errors} blocage${errors > 1 ? "s" : ""}` : warnings ? `${warnings} point${warnings > 1 ? "s" : ""} à surveiller` : "Tous les services sont opérationnels"}</strong><small>Contrôlé le {health.checkedAt.toLocaleString("fr-FR")}</small></div>
    </section>

    <section className="health-ledger" aria-label="Diagnostics des services">
      {health.checks.map((check) => <article key={check.key} className={`health-row ${check.level}`}>
        <span className="health-icon">{check.level === "healthy" ? <CheckCircle2 size={20}/> : <CircleAlert size={20}/>}</span>
        <div><span>{check.label}</span><strong>{check.summary}</strong><p>{check.detail}</p></div>
        <em>{check.level === "healthy" ? "Opérationnel" : check.level === "warning" ? "À surveiller" : "Bloqué"}</em>
      </article>)}
    </section>

    <section className="health-actions card">
      <div><ShieldCheck size={20}/><span><strong>Diagnostic Gemini sécurisé</strong><small>Le test appelle uniquement <code>gemini-embedding-001</code> avec une phrase technique fixe. Aucune clé ni donnée client n’apparaît dans les journaux.</small></span></div>
      <Link className="button secondary" href="/studio/sante?probe=embedding"><RefreshCw size={15}/> Tester l’embedding</Link>
    </section>
  </div>;
}
