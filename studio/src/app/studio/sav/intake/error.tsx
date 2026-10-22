"use client";
import Link from "next/link";
export default function IntakeConsoleError({ reset }: { reset: () => void }) {
  return <section className="card" role="alert"><h2>Le dossier n’est pas disponible</h2>
    <p>Le chargement a échoué. Aucun compteur ni résultat vide n’est présenté comme confirmé.</p>
    <button type="button" onClick={reset}>Réessayer</button> <Link href="/studio/sav">Retour à la file supervisée</Link>
  </section>;
}
