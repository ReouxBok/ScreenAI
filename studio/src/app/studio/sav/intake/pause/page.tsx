import Link from "next/link";
import { formatParisDateTime } from "@/lib/paris-date";
import { readSavAgentPausePanel } from "@/lib/sav/intake/agent-pause-admin";
import { SAV_AGENT_PAUSE_LEVEL_LABELS } from "../agent-pause-banner";
import { PauseForm } from "./pause-form";
import styles from "../intake.module.css";
export const dynamic = "force-dynamic";
const label = (level: string) => level === "running" ? "agent actif" : level === "invalid" ? "réglage illisible" : SAV_AGENT_PAUSE_LEVEL_LABELS[level as keyof typeof SAV_AGENT_PAUSE_LEVEL_LABELS] ?? level;
export default async function IntakePausePage() {
  const { state, history } = await readSavAgentPausePanel(), s = state.setting;
  return <div className={styles.console}>
    <Link className={styles.back} href="/studio/sav/intake">← Nouveaux dossiers</Link>
    <header className={styles.heading}><div><span className="eyebrow">Administration SAV</span><h1>Pause de l’agent</h1>
      <p>Pause de l’agent d’accueil (intake) uniquement : la campagne de comparaison et l’ancien circuit V0 n’en dépendent pas. Une pause n’efface rien et les dossiers en attente reprennent à la relance.</p>
      <ul>
        <li>Suspendre les actions : l’analyse continue et ses appels IA sont facturés normalement ; aucune nouvelle action HubSpot ou Gmail ne part.</li>
        <li>Pause complète : aucune nouvelle analyse ni aucun appel IA n’est lancé ; une analyse interrompue ne consomme ni tentative automatique ni essai de reprise humaine.</li>
        <li>Dans les deux cas, un appel IA déjà lancé garde son coût, une action déjà envoyée va au bout et reste vérifiée en lecture seule.</li>
      </ul></div></header>
    {state.invalid && <p role="alert">Le réglage enregistré est illisible : l’agent est en pause complète par sécurité (<code>SAV_INTAKE_AGENT_PAUSE_INVALID</code>) jusqu’à un nouvel enregistrement.</p>}
    <section className={styles.choice}>
      <h2>État actuel</h2>
      <dl>
        <dt>Niveau</dt><dd>{state.invalid ? label("invalid") : label(state.level)}</dd>
        {s && <><dt>Depuis</dt><dd>{formatParisDateTime(s.setAt)} par {s.setBy}</dd><dt>Motif</dt><dd>{s.reason}</dd></>}
      </dl>
    </section>
    <PauseForm current={state.invalid ? "invalid" : state.level}/>
    <section className={styles.choice}>
      <h2>Derniers changements</h2>
      {history.length ? <ul>{history.map(h => <li key={h.at + h.actor}><time dateTime={h.at}>{formatParisDateTime(h.at)}</time> — {h.actor} : {label(h.previousLevel)} → {label(h.nextLevel)} · {h.reason}</li>)}</ul> : <p>Aucun changement enregistré.</p>}
    </section>
  </div>;
}
