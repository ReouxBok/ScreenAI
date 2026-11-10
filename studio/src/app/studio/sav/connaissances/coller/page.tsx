import Link from "next/link";
import { requireSavStaff } from "@/lib/sav/auth";
import { PasteNewForm } from "../paste-new-form";
import styles from "../workspace.module.css";

export const dynamic = "force-dynamic";
export default async function PasteKnowledgePage() {
  await requireSavStaff();
  return <div className={styles.workspace}><Link className="back-link" href="/studio/sav/connaissances">← Bibliothèque des connaissances</Link><div className={styles.heading}><div><span className="eyebrow">Proposition interne</span><h1>Ajouter une connaissance par texte collé</h1><p className={styles.subtle}>Le texte devient un brouillon de proposition. Rien n’est publié ni activé : la revue humaine reste obligatoire.</p></div></div><PasteNewForm/></div>;
}
