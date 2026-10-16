import Link from "next/link";
import { requireSavStaff } from "@/lib/sav/auth";
import { listSavLearningSignals } from "@/lib/sav/learning-signals";
import { triageLearningSignal } from "./actions";
export const dynamic = "force-dynamic";
const labels = { knowledge_gap: "Connaissance manquante", draft_rejected: "Brouillon refusé", draft_changed: "Brouillon corrigé humainement", coherence_rejected: "Contrôle de cohérence refusé", unknown_fact: "Information à ajouter au dictionnaire" };
export default async function SavLearningSignalsPage() {
  const staff = await requireSavStaff();
  const data = await listSavLearningSignals(staff.email);
  return <div className="stack"><Link href="/studio/sav/connaissances">← Connaissances</Link><h1>Apprentissage : signaux à trier</h1>
    <p>{data.scanned} analyses récentes examinées{data.truncated ? " · aperçu limité aux 500 dernières analyses" : ""}. Les groupes sont classés par volume et impact ; leur classement reste à confirmer humainement.</p>
    <p>Préparer ouvre un brouillon à compléter et sourcer. Cette action ne publie ni n’active une connaissance. Les résolutions HubSpot qualifiées restent dans <Link href="/studio/sav/connaissances?tab=automatic">les propositions automatiques</Link>.</p>
    <p>Les règles du master prompt se corrigent dans <Link href="/studio/sav/connaissances/playbook">Master prompt SAV</Link>.</p>
    {!data.groups.length && <p>Aucun nouveau groupe à examiner sur cette fenêtre.</p>}
    {data.groups.map(group => <section key={group.id} className="card"><h2>{labels[group.kind]} · {group.domain}</h2>
      <p>{group.count} observations · {group.cardId ? "Amélioration d’une fiche existante à examiner" : "Nouvelle connaissance à documenter"}</p>
      <p>Version du master prompt : {group.playbookVersionId}</p>
      <form action={triageLearningSignal}><input type="hidden" name="groupId" value={group.id}/><button name="decision" value="prepare">Confirmer et préparer un brouillon</button><button className="secondary" name="decision" value="reject">Écarter ce groupe</button></form>
    </section>)}
  </div>;
}
