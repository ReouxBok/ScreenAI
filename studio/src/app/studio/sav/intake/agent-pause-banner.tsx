import Link from "next/link";
import { formatParisDateTime } from "@/lib/paris-date";
import { readSavAgentPauseBanner, type SavAgentPauseBanner } from "@/lib/sav/intake/agent-pause-admin";
import styles from "./intake.module.css";

export const SAV_AGENT_PAUSE_LEVEL_LABELS = {
  actions_paused: "actions suspendues (l’analyse continue, aucune action HubSpot ou Gmail)",
  fully_paused: "pause complète (ni analyse, ni appel IA, ni action)",
} as const;
/** Console banner while the agent is paused, plus the entry to the pause page for administrators. */
export async function AgentPauseBanner({ role }: { role: string }) {
  const admin = ["admin", "owner"].includes(role);
  // Unreadable state shows as a full pause: the runtime fails closed on the same read.
  const pause: SavAgentPauseBanner | null = await readSavAgentPauseBanner().catch(() => ({ level: "fully_paused" as const, setBy: null, setAt: null, invalid: true }));
  const manage = admin && <Link href="/studio/sav/intake/pause">{pause ? "Gérer la pause" : "Mettre l’agent en pause"}</Link>;
  if (!pause) return admin ? <p className={styles.actions}>{manage}</p> : null;
  return <p role="alert" className={styles.blockedAlert}>
    {pause.invalid ? <>Réglage de pause illisible : l’agent est en pause complète par sécurité (<code>SAV_INTAKE_AGENT_PAUSE_INVALID</code>).</>
      : <>Agent en pause depuis {formatParisDateTime(pause.setAt)} par {pause.setBy} — niveau {SAV_AGENT_PAUSE_LEVEL_LABELS[pause.level]}. Les emails reçus sont conservés et attendent la reprise.</>}
    {manage && <> {manage}</>}
  </p>;
}
