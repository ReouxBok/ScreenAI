import Link from "next/link";
import { readIntakeComparisonEvidence } from "@/lib/sav/intake/comparison-operator";
import { AttestationForm } from "../attestation-form";
import styles from "../../intake.module.css";
export const dynamic = "force-dynamic";
/** One dossier's private receipt, administrator only. Rendered as escaped text: no HTML from a mail,
 * no link or button acting on a customer, a ticket or a mailbox. */
export default async function ComparisonEvidencePage({ params }: { params: Promise<{ messageId: string }> }) {
  const { messageId } = await params;
  const detail = await readIntakeComparisonEvidence(messageId);
  const receiptSha256 = (detail.detail?.evidence as { receiptSha256?: string } | undefined)?.receiptSha256 ?? null;
  const attestable = detail.qualificationEvidence === "complete" && detail.verification?.ok === true && detail.attestation === null && receiptSha256 !== null;
  return <div className={styles.console}>
    <Link className={styles.back} href="/studio/sav/intake/comparison">← Comparaison des lecteurs</Link>
    <header className={styles.heading}><div><span className="eyebrow">Preuve privée — administrateur</span><h1>Reçu de qualification</h1>
      <p>Comparaison sans exécution : aucun email, ticket ni propriétaire n’a été modifié.</p></div></header>
    <section className={styles.choice}>
      <p>État : {detail.state} · projection : {detail.verdict ?? "aucune"} (ce n’est pas un jugement métier).</p>
      <p>Preuve : {detail.qualificationEvidence ?? "absente"}{detail.verification ? ` · vérification : ${detail.verification.ok ? "intègre" : detail.verification.reason}` : ""}.</p>
      {receiptSha256 && <p>Empreinte du reçu : <code>{receiptSha256}</code></p>}
      <p>Attestation : {detail.attestation === null ? "aucune" : detail.attestation === "invalid" ? "invalide" : `${detail.attestation.outcome} · attendu ${detail.attestation.oracleSha256}`}</p>
    </section>
    {attestable && <AttestationForm campaignId={detail.campaignId} messageId={detail.messageId} receiptSha256={receiptSha256!}/>}
    <details className={styles.choice}><summary>Reçu complet</summary><pre>{JSON.stringify(detail.receipt, null, 2)}</pre></details>
    <details className={styles.choice}><summary>Résultat résumé</summary><pre>{JSON.stringify(detail.detail, null, 2)}</pre></details>
  </div>;
}
