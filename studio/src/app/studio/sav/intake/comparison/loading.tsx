import { IntakeAdminSkeleton } from "../skeletons";
export default function IntakeComparisonLoading() {
  return <IntakeAdminSkeleton eyebrow="Qualification séparée" title="Comparer les lecteurs SAV" blocks={[150, 180, 180]}
    subtitle="Aucun email ni ticket modifié. Le lecteur des nouveaux emails reste inchangé."/>;
}
