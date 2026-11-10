"use client";
import { BackLink } from "@/components/ui/back-link";
import { Button, ErrorState } from "@/components/ui/primitives";
export default function ArchivesError({ reset }: { reset: () => void }) {
  return <ErrorState title="Les archives ne sont pas disponibles" actions={<><Button onClick={reset}>Réessayer</Button><BackLink fallback="/studio/sav/archives"/></>}>
    Le chargement a échoué. Rien n’a été modifié ; aucun dossier ni résultat vide n’est présenté comme confirmé.
  </ErrorState>;
}
