import { notFound } from "next/navigation";
import { evaluationAdministrator } from "@/lib/sav/intake/server-auth";
import { evaluationConfig } from "@/lib/sav/intake/server-contract";
import EvaluationForm from "./evaluation-form";

/** Outside the Studio layout: no getStaff()/staff provisioning side effect. */
export default async function IntakeEvaluationPage() {
  let config;
  try { config = evaluationConfig(process.env); } catch { notFound(); }
  await evaluationAdministrator();
  return <main style={{ maxWidth: 900, margin: "3rem auto", padding: "1.5rem" }}>
    <h1>Évaluation privée du classement SAV</h1>
    <p>Trois dossiers autorisés, plafond total de 3 USD. Aucune action HubSpot, aucun envoi de mail et aucune modification des dossiers SAV.</p>
    <p>Les appels et résultats seront inscrits dans le journal technique d’évaluation. Une exécution interrompue ne peut pas être relancée automatiquement.</p>
    <p>Campagne : <code>{config.campaignId}</code> · Fin de validité : {config.expiresAt}</p>
    <p>Empreinte du fichier autorisé : <code>{config.manifestHash}</code></p>
    <EvaluationForm />
  </main>;
}
