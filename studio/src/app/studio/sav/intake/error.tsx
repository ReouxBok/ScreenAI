"use client";
import { BackLink } from "@/components/ui/back-link";
import { Button, ErrorState } from "@/components/ui/primitives";
import { INTAKE_LIST_PATH } from "@/lib/sav/intake-ux/navigation";
export default function IntakeConsoleError({ reset }: { reset: () => void }) {
  return <ErrorState title="Le dossier n’est pas disponible" actions={<><Button onClick={reset}>Réessayer</Button><BackLink fallback={INTAKE_LIST_PATH}/></>}>
    Le chargement a échoué. Aucun compteur ni résultat vide n’est présenté comme confirmé.
  </ErrorState>;
}
