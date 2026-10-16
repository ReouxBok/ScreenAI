import type { SavStructuredProposal } from "@/lib/sav/proposal";
import { savCategoryLabels, savLabel } from "@/lib/sav/labels";
import styles from "./dossier.module.css";

const natureLabels: Record<string, string> = {
  technical: "Dysfonctionnement", account: "Compte et accès", integration: "Intégration", how_to: "Utilisation",
  financial_operation: "Opération financière", financial_data: "Informations financières", cancellation: "Résiliation",
  commercial: "Commercial", partnership: "Partenariat", callback: "Rappel", human_request: "Prise en charge humaine",
  security: "Sécurité", privacy: "Confidentialité", data_deletion: "Suppression de données", legal: "Juridique",
  acknowledgement: "Accusé de réception", non_support: "Hors support", unknown: "À qualifier",
};

/** What the reviewer needs to read first. The human correction wins over the AI understanding when present. */
export function savFindings(p: SavStructuredProposal) {
  const human = p.humanProcess?.understanding;
  if (human) {
    const primary = human.requests.find(r => r.id === human.primaryRequestId) ?? human.requests[0];
    return { situation: primary?.summary ?? p.decision.explanation, nature: primary?.nature, product: primary?.product || null, feature: primary?.feature || null,
      requestCount: human.requests.length, known: human.knownFacts, attempted: human.attemptedSteps, missing: human.missingInformation, corrected: true };
  }
  const u = p.understanding;
  const primary = u?.requests.find(r => r.id === u.primaryRequestId);
  return { situation: primary?.summary ?? (p.internalNote?.replace(/^Analyse pilote IA — à valider\s*/u, "").trim() || p.decision.explanation),
    nature: primary?.nature, product: primary?.product ?? null, feature: primary?.feature ?? null, requestCount: u?.requests.length ?? 1,
    known: u?.knownFacts.map(f => f.text) ?? [], attempted: u?.attemptedSteps.map(f => f.text) ?? [], missing: u?.missingInformation.map(f => f.text) ?? [], corrected: false };
}

export function FindingsSummary({ proposal }: { proposal: SavStructuredProposal }) {
  const f = savFindings(proposal);
  const list = (items: string[], empty: string) => items.length ? <ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>{empty}</p>;
  return <div className={styles.block}>
    <div className={styles.blockHeader}><h3 className={styles.blockTitle}>Situation décrite</h3>{f.corrected && <small>Compréhension corrigée par un humain</small>}</div>
    <p className={styles.situation}>{f.situation}</p>
    <ul className={styles.chips} aria-label="Qualification">
      <li>{f.nature ? natureLabels[f.nature] ?? "À qualifier" : savLabel(savCategoryLabels, proposal.category)}</li>
      {(f.product || f.feature) && <li>{[f.product, f.feature].filter(Boolean).join(" · ")}</li>}
      <li>{f.requestCount} demande{f.requestCount > 1 ? "s" : ""}</li>
    </ul>
    <div className={styles.facts}>
      <div><h3>Déjà connu</h3>{list(f.known, "Rien de relevé")}</div>
      <div><h3>Déjà essayé</h3>{list(f.attempted, "Rien de mentionné")}</div>
      <div><h3>À demander</h3>{list(f.missing, "Rien à demander")}</div>
    </div>
  </div>;
}

type KnowledgeSource = SavStructuredProposal["sources"][number];
/** Only knowledge that actually supports the response or process, never every retrieved result. */
export function savUsedKnowledge(p: SavStructuredProposal): KnowledgeSource[] {
  return p.sources.filter(source => source.sourceType === "knowledge" && (source.claim || source.excerpt || p.process.some(step => step.sourceIds.includes(source.sourceId))));
}

export function UsedKnowledge({ proposal }: { proposal: SavStructuredProposal }) {
  const knowledge = savUsedKnowledge(proposal);
  return <div className={styles.block}>
    <h3 className={styles.blockTitle}>Connaissances utilisées</h3>
    {knowledge.length ? <ul className={styles.knowledge}>{knowledge.map((source, index) => <li key={`${source.sourceId}:${index}`}>
      <strong>{source.title}</strong>
      {source.claim && <span className={styles.muted}>{source.claim}</span>}
      {source.excerpt && <blockquote>« {source.excerpt} »</blockquote>}
      {source.contentVersionId && <small className={styles.muted}>Version de connaissance : {source.contentVersionId}</small>}
    </li>)}</ul> : <p className={styles.muted}>Aucune connaissance spécifique utilisée dans cette proposition.</p>}
  </div>;
}
