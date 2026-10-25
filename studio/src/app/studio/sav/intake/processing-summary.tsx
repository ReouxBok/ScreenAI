import styles from "./intake.module.css";

export function IntakeProcessingSummary({ status, cause, question, lastActivity, confirmedEffects, uncertain, paused, exhausted }: {
  status: string; cause: string | null; question: string | null; lastActivity?: string; confirmedEffects: number; uncertain: boolean; paused: boolean; exhausted: boolean;
}) {
  const next = uncertain ? "Le résultat doit être rapproché avant toute poursuite. Les actions confirmées ne doivent pas être renvoyées."
    : paused ? "La pause humaine doit être examinée par un opérateur autorisé."
      : exhausted ? "Les tentatives sont épuisées. Une intervention technique est requise ; aucun compteur n’est remis à zéro."
        : "Consultez les dernières preuves et les commandes conservées. Aucun horaire de reprise n’est confirmé par cet écran.";
  return <section className={styles.decision} aria-label="Étape et prochaine action">
    <h2>{question ?? "Suivi du traitement"}</h2>
    <dl><div><dt>Étape actuelle</dt><dd>{status}</dd></div><div><dt>Actions vérifiées</dt><dd>{confirmedEffects} effet{confirmedEffects > 1 ? "s" : ""} confirmé{confirmedEffects > 1 ? "s" : ""}</dd></div></dl>
    {cause && <p>{cause}</p>}
    {lastActivity && <p>Dernière trace enregistrée : {lastActivity}</p>}
    <p>{next}</p>
    <p>Les reprises disponibles sont proposées aux opérateurs autorisés dans le panneau de poursuite. Le diagnostic conserve les causes et les résultats déjà confirmés.</p>
  </section>;
}
