"use client";
import { BackLink } from "@/components/ui/back-link";
import { Button, ErrorState } from "@/components/ui/primitives";
// Covers the SAV pages without their own error state (old list and dossier,
// pilot lab, resolutions, knowledge). The intake console and archives keep theirs.
export default function SavError({ reset }: { reset: () => void }) {
  return <ErrorState title="Cette page SAV n’est pas disponible" actions={<><Button onClick={reset}>Réessayer</Button><BackLink fallback="/studio/sav/intake"/></>}>
    Le chargement a échoué. Rien n’a été modifié ; aucun dossier, compteur ni résultat vide n’est présenté comme confirmé.
  </ErrorState>;
}
