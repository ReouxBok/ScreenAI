import styles from "./loading-state.module.css";

export function SavLoadingState({ dossier = false }: { dossier?: boolean }) {
  return <section className={styles.loading} aria-busy="true" aria-label={dossier ? "Chargement du dossier SAV" : "Chargement des dossiers SAV"}>
    <div className="page-intro compact"><div><span className="eyebrow">SAV IA</span><h1>{dossier ? "Dossier SAV" : "Piloter les demandes"}</h1></div></div>
    <p role="status">{dossier ? "Chargement du dossier…" : "Chargement des dossiers…"}</p>
    <div className={styles.placeholder} aria-hidden="true"/>
    <div className={styles.placeholder} aria-hidden="true"/>
    <div className={styles.placeholder} aria-hidden="true"/>
  </section>;
}
