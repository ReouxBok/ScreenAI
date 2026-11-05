import { Status } from "@/components/ui/primitives";
import { readV2PipelineWiring } from "./pipeline-wiring";
import styles from "./v2.module.css";

// Read-only: what this build wires for each V2 step (pipeline-wiring.ts, checked against the sources). Nothing is triggered from here.
export function PipelinePanel({ env = process.env }: { env?: Readonly<Record<string, string | undefined>> }) {
  // A technical diagnostic, kept apart from the operator's path (what blocks, what is proven): folded by default, read only.
  return <details className={styles.card} id="v2-wiring">
    <summary>Diagnostic technique : raccords de cette version</summary>
    <p className={styles.small}>Ce qui est réellement branché dans cette version du Studio. « Présent, non branché » veut dire qu’aucun traitement ne tourne : rien n’est en cours pour autant.</p>
    <ul>{readV2PipelineWiring(env).map(row => <li key={row.step}>
      <Status tone={row.state === "wired_behind_flag" ? "neutral" : "warning"}>{row.stateLabel}</Status> <strong>{row.label}</strong>{row.flagLabel ? <span className={styles.small}> ({row.flagLabel})</span> : null}
      <br/><span className={styles.small}>{row.detail}</span>
    </li>)}</ul>
  </details>;
}
