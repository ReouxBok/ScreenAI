import Link from "next/link";
import { exportRodageMarkdown, readRodageReport, rodageAdministrator, rodageGoNoGo, RODAGE_CATEGORIES, RODAGE_THRESHOLDS } from "@/lib/sav/blocks/block-rodage";
import { saveRodageVerdictAction } from "./actions";

export const dynamic = "force-dynamic";
export default async function RodagePage({ searchParams }: { searchParams: Promise<{ bloc?: string; from?: string; to?: string; saved?: string }> }) {
  await rodageAdministrator();
  const params = await searchParams, now = new Date();
  const window = { blockId: params.bloc ?? "access", from: params.from ?? new Date(now.getTime() - 12 * 3600_000).toISOString(), to: params.to ?? now.toISOString() };
  const report = await readRodageReport(window), stats = rodageGoNoGo(report);
  return <main className="page-content">
    <Link href="/studio/sav">← SAV</Link><h1>Rodage d’un bloc</h1>
    <p>Prévoir une demi-journée en mode brouillon : réponse proposée, jamais envoyée par le bloc. Cette page annote les propositions et n’active rien.</p>
    <form method="get"><p><label>Bloc <input name="bloc" required defaultValue={window.blockId}/></label></p>
      <p><label>Début (ISO avec fuseau) <input name="from" required defaultValue={window.from}/></label></p>
      <p><label>Fin (ISO avec fuseau, 24 h maximum) <input name="to" required defaultValue={window.to}/></label></p><button>Consulter le rodage</button></form>
    {params.saved === "1" && <p role="status">Verdict enregistré.</p>}
    <h2>{stats.result}</h2>
    <p>Critères : au moins {RODAGE_THRESHOLDS.minDrafts} brouillons, {RODAGE_THRESHOLDS.minGoodRatio * 100} % bons, aucun sensible raté et aucun hors bloc admis. Les brouillons sans verdict comptent dans le dénominateur.</p>
    <p>Admis : {stats.admitted} ; brouillons : {stats.drafts} ; bons : {stats.good} ({Math.round(stats.goodRatio * 100)} %) ; passages à l’équipe : {stats.handoffs} ; sensibles ratés : {stats.sensitiveMissed} ; hors bloc admis : {stats.outOfBlock}.</p>
    <p>Verdicts : {JSON.stringify(stats.verdicts)}. Refus par motif : {JSON.stringify(stats.refusedByReason)}.</p>
    <p>Lecture : l’admission doit être applicable au moment de chaque proposition. Une qualification historique remplacée n’est pas reconstituable et interdit GO. Chaque proposition distincte est évaluée ; un nouveau brouillon exige un nouveau verdict. Les résumés de demande sont structurels, sans texte client.</p>
    {report.historyUncertain && <p role="alert">Historique incertain : aucun GO possible. L’admission applicable à certaines propositions ne peut pas être établie.</p>}
    {report.incomplete && <p role="alert">Lecture tronquée : aucun GO possible. Réduire la fenêtre.</p>}
    <Link href="/studio/sav/intake/blocks">Consulter l’interrupteur du bloc</Link>
    {report.cases.map(c => <section key={`${c.caseId}:${c.draftId}`}><h2>Dossier {c.caseId}</h2><p>Proposition : {c.proposedAt ?? "aucune"}</p><p>{c.summary}</p>
      <p>{c.admitted ? "Admis" : "Refusé à l’admission"} — Décision proposée : {c.action}. {c.responseSummary}</p>
      {c.responseText && <details><summary>Lire la réponse proposée (hors export)</summary><pre style={{ whiteSpace: "pre-wrap" }}>{c.responseText}</pre></details>}
      <p>Fiches : {c.citations.map(k => `${k.knowledgeId}@${k.contentVersionId}`).join(", ") || "aucune"}</p>
      <p>Refus du validateur : {c.refusals.join(", ") || "aucun observé"}</p><p>Suite : {c.afterwards.join(", ") || "non observée dans la fenêtre"}</p>
      {c.draftId && <form action={saveRodageVerdictAction}>
        <input type="hidden" name="blockId" value={window.blockId}/><input type="hidden" name="caseId" value={c.caseId}/><input type="hidden" name="draftId" value={c.draftId}/>
        <input type="hidden" name="from" value={window.from}/><input type="hidden" name="to" value={window.to}/>
        <p><label>Verdict <select name="verdict" defaultValue={c.verdict?.verdict ?? "à corriger"}><option>bon</option><option>à corriger</option><option>hors périmètre</option></select></label></p>
        <p><label>Catégorie (pour « à corriger ») <select name="category" defaultValue={c.verdict?.category ?? ""}><option value="">Aucune</option>{RODAGE_CATEGORIES.map(v => <option key={v}>{v}</option>)}</select></label></p>
        <p><label>Raison libre (obligatoire pour « à corriger ») <textarea name="reason" maxLength={2000} defaultValue={c.verdict?.reason ?? ""}/></label></p><button>Enregistrer le verdict</button>
      </form>}
    </section>)}
    <h2>Export Markdown</h2><p>Copier ce rapport pour Ugo et la correction des fiches. Les raisons libres restent dans les verdicts chiffrés ; elles sont exclues de l’export pour éviter toute citation client.</p>
    <textarea aria-label="Rapport Markdown" readOnly rows={20} style={{ width: "100%" }} value={exportRodageMarkdown(report)}/>
  </main>;
}
