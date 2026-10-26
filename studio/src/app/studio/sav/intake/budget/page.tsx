import Link from "next/link";
import { readIntakeBudgetPanel } from "@/lib/sav/intake/budget-admin";
import { formatNanoUsd } from "@/lib/sav/intake/budget-amount";
import { BudgetForm } from "./budget-form";
import styles from "../intake.module.css";
export const dynamic = "force-dynamic";
const usd = (nano: number | null | undefined) => typeof nano === "number" ? formatNanoUsd(nano) : "—";
export default async function IntakeBudgetPage() {
  const panel = await readIntakeBudgetPanel(), u = panel.usage;
  return <div className={styles.console}>
    <Link className={styles.back} href="/studio/sav/intake">← Nouveaux dossiers</Link>
    <header className={styles.heading}><div><span className="eyebrow">Administration SAV</span><h1>Budget quotidien de l’analyse IA</h1>
      <p>Chaque appel au modèle réserve {formatNanoUsd(817_152_000)} avant de partir ; seul son coût réel reste compté ensuite. Un appel au coût inconnu garde sa réservation jusqu’à confirmation.</p></div></header>
    {panel.configurationError && <p role="alert">Configuration runtime indisponible : <code>{panel.configurationError}</code>. Le plafond Studio reste enregistrable mais l’usage ne peut pas être lu.</p>}
    {panel.overrideInvalid && <p role="alert">Le réglage enregistré est illisible : les analyses sont suspendues jusqu’à un nouvel enregistrement.</p>}
    {!panel.operational && !panel.configurationError && <p role="alert">Le profil courant n’est pas opérationnel : le plafond Studio ne s’applique pas.</p>}
    <section className={styles.choice}>
      <h2>Aujourd’hui (jour UTC)</h2>
      <dl>
        <dt>Plafond effectif</dt><dd>{usd(panel.effectiveNanoUsd)} {panel.override?.maxNanoUsd ? "(réglage Studio)" : "(configuration)"}</dd>
        <dt>Plafond de la configuration</dt><dd>{usd(panel.configuredNanoUsd)}</dd>
        <dt>Compté aujourd’hui</dt><dd>{usd(u?.chargedNanoUsd)}{u?.uncertain ? " — dont des réservations au coût encore inconnu" : ""}</dd>
        <dt>Marge restante</dt><dd>{usd(u?.remainingNanoUsd)}</dd>
        <dt>Appels aujourd’hui</dt><dd>{u ? `${u.callCount} / ${u.maxCalls}` : "—"}</dd>
        <dt>Sur 30 jours glissants</dt><dd>{u ? `${usd(u.rollingChargedNanoUsd)} / ${usd(u.maxRollingNanoUsd)}` : "—"}</dd>
      </dl>
    </section>
    <BudgetForm ceilingUsd={formatNanoUsd(panel.ceilingNanoUsd)} hasOverride={Boolean(panel.override?.maxNanoUsd)}/>
    <section className={styles.choice}>
      <h2>Derniers changements</h2>
      {panel.history.length ? <ul>{panel.history.map(h => <li key={h.at + h.actor}><time>{h.at}</time> — {h.actor} : {typeof h.previousNanoUsd === "number" ? usd(h.previousNanoUsd) : h.previousNanoUsd === "invalid" ? "réglage illisible" : "configuration"} → {h.nextNanoUsd === null ? "configuration" : usd(h.nextNanoUsd)} · {h.reason}</li>)}</ul> : <p>Aucun changement enregistré.</p>}
    </section>
  </div>;
}
