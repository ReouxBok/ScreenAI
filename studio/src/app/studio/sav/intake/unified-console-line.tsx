import Link from "next/link";
import { unifiedBucketLabels, type UnifiedLine } from "./unified-console-model";
import styles from "./unified-console.module.css";
// Rendered beside (not inside) the row link: the V2 link must not nest in the dossier anchor.
export function UnifiedConsoleLine({ line, origin }: { line: UnifiedLine | undefined; origin: string }) {
  if (!line) return null;
  return <div className={styles.line} data-bucket={line.bucket}>
    <span className={styles.bucket}>{unifiedBucketLabels[line.bucket]}</span>
    <span>{line.stage}</span><span>{line.ticket}</span><span>Responsable : {line.owner}</span>{line.reply && <span>{line.reply}</span>}
    <span className={styles.next}>Prochaine action sûre : {line.next}</span>
    {line.paused && <span className={styles.paused}>Pause active</span>}
    {line.v2Href && <Link href={`${line.v2Href}?${new URLSearchParams({ returnTo: origin })}`}>Ouvrir le dossier V2 de ce ticket</Link>}
  </div>;
}
