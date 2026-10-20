"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export function SavProjectionProgress() {
  const router = useRouter(), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (attempt >= 10) return;
    const timer = setTimeout(() => { setAttempt(value => value + 1); router.refresh(); }, 2000);
    return () => clearTimeout(timer);
  }, [attempt, router]);
  return <section className="card" aria-busy={attempt < 10}>
    <h2>Actualisation des dossiers</h2>
    <p role="status">{attempt < 10 ? "La liste se met à jour. Les compteurs seront affichés dès qu’ils seront actualisés." : "L’actualisation prend plus de temps. Vous pouvez réessayer dans quelques instants."}</p>
    {attempt >= 10 && <button className="secondary" onClick={() => { setAttempt(0); router.refresh(); }}>Réessayer</button>}
  </section>;
}
