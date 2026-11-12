import Link from "next/link";
import { formatParisDateTime } from "@/lib/paris-date";
import { readSavBlockSwitchPanel } from "@/lib/sav/cases/block-switch-admin";
import { BlockSwitchForm } from "./block-form";
import styles from "../intake.module.css";
export const dynamic = "force-dynamic";
const BLOCK_LABELS: Record<string, string> = { access: "Accès (connexion)" };
const MODE_LABELS: Record<string, string> = { off: "arrêt", draft: "brouillon", auto: "automatique", paused: "en pause", invalid: "réglage illisible" };
const stateLabel = (value: string) => value.split("+").map(part => MODE_LABELS[part] ?? part).join(" + ");
export default async function BlockSwitchPage() {
  const { globalAutoReply, blocks } = await readSavBlockSwitchPanel();
  return <div className={styles.console}>
    <Link className={styles.back} href="/studio/sav/intake">← Nouveaux dossiers</Link>
    <header className={styles.heading}><div><span className="eyebrow">Administration SAV</span><h1>Blocs de traitement</h1>
      <p>Mode et pause de chaque bloc. Ce réglage ne peut que restreindre : l’état effectif est le plus strict entre le mode du bloc et l’interrupteur global de réponse automatique.</p>
      <ul>
        <li>Arrêt ou pause : le bloc n’envoie rien ; ses dossiers attendent avec un motif visible, sans être perdus.</li>
        <li>Brouillon : chaque réponse est proposée à un humain pour validation.</li>
        <li>Automatique : comportement actuel. Une réponse déjà mise en file avant le changement n’est pas retenue par ce réglage (utiliser la pause de l’agent).</li>
      </ul>
      <p>Interrupteur global de réponse automatique : <strong>{globalAutoReply ? "activé" : "désactivé"}</strong> (configuration, non modifiable ici).</p></div></header>
    {blocks.map(block => <section key={block.blockId} className={styles.choice}>
      <h2>{BLOCK_LABELS[block.blockId] ?? block.blockId}</h2>
      {block.invalid && <p role="alert">Le réglage enregistré est illisible : le bloc n’envoie rien par sécurité (<code>block_setting_invalid</code>) jusqu’à un nouvel enregistrement.</p>}
      <dl>
        <dt>Mode</dt><dd>{block.invalid ? stateLabel("invalid") : stateLabel(block.mode)}{block.paused ? " — en pause" : ""}{block.setting ? "" : " (valeur par défaut)"}</dd>
        <dt>État effectif</dt><dd>{stateLabel(block.effective)}</dd>
        {block.setting && <><dt>Depuis</dt><dd>{formatParisDateTime(block.setting.setAt)} par {block.setting.setBy}</dd><dt>Motif</dt><dd>{block.setting.reason}</dd></>}
      </dl>
      <BlockSwitchForm blockId={block.blockId} mode={block.invalid ? "invalid" : block.mode} paused={block.paused}/>
      <h3>Derniers changements</h3>
      {block.history.length ? <ul>{block.history.map((h, index) => <li key={index}><time dateTime={h.at}>{formatParisDateTime(h.at)}</time> — {h.actor} : {stateLabel(h.previous)} → {stateLabel(h.next)} · {h.reason}</li>)}</ul> : <p>Aucun changement enregistré.</p>}
    </section>)}
  </div>;
}
