import { formatParisDateTime } from "@/lib/paris-date";
import { savActionLabels, savActionStatusLabels, savDecisionLabels, savLabel, savThreadStatusLabels } from "@/lib/sav/labels";
import { Badge, Status } from "@/components/ui/primitives";
import { Card, Collapsible } from "@/components/ui/forms";
import type { UiTone } from "@/components/ui/tokens";
import styles from "./archives.module.css";

// SAV-60: consultative view of a V0 dossier. It renders what was stored and
// nothing else: no form, no button that posts, no client component that calls
// the server on mount. Old wording is kept; effects keep their recorded state.

type Message = { id: string; direction: string; fromEmail: string; subject: string; receivedAt: Date; body: { text: string } };
type Decision = { id: string; kind: string; explanation: string; confidence: number; isCurrent: boolean; actorType: string; actorEmail: string | null; createdAt: Date };
type Action = { id: string; kind: string; status: string; errorCode: string | null; actorEmail: string | null; createdAt: Date; executedAt: Date | null; draftText: string | null; noteText: string | null };
type DraftVersion = { id: string; revision: number; status: string; createdAt: Date; createdBy: string | null; text: string; origin: string; isCurrent: boolean };
export type ArchiveDossier = {
  thread: { id: string; subject: string; customerEmail: string; status: string; lastMessageAt: Date; hubspotTicketId: string | null; aiPaused?: boolean };
  messages: Message[]; decisions: Decision[]; actions: Action[];
};

const actionTone = (status: string): UiTone => status === "succeeded" ? "success" : status === "failed" ? "danger" : status === "pending" || status === "running" ? "warning" : "neutral";
const when = (value: Date | null | undefined) => value ? formatParisDateTime(value) : "—";

export function ArchiveDossierView({ dossier, drafts }: { dossier: ArchiveDossier; drafts: DraftVersion[] }) {
  const { thread, messages, decisions, actions } = dossier;
  return <div className={styles.archive}>
    <Card title="Échanges" description={`${messages.length} message${messages.length > 1 ? "s" : ""} enregistré${messages.length > 1 ? "s" : ""}`}>
      {messages.length ? <ol className={styles.timeline}>{messages.map(message => <li key={message.id}>
        <div className={styles.meta}><strong>{message.direction === "inbound" ? "Client" : "Limova"}</strong><span>{message.fromEmail}</span><time dateTime={message.receivedAt.toISOString()}>{when(message.receivedAt)}</time></div>
        <p className={styles.body}>{message.body.text || "Message sans texte enregistré."}</p>
      </li>)}</ol> : <p className={styles.empty}>Aucun message enregistré pour ce dossier.</p>}
    </Card>
    <Card title="Décisions de l’ancien circuit" description="Telles qu’enregistrées à l’époque ; elles ne s’appliquent pas au message actuel.">
      {decisions.length ? <ul className={styles.rows}>{decisions.map(decision => <li key={decision.id}>
        <div className={styles.rowHead}><strong>{savLabel(savDecisionLabels, decision.kind)}</strong>{decision.isCurrent ? <Badge>Dernière décision</Badge> : <Badge>Remplacée</Badge>}</div>
        <p>{decision.explanation}</p>
        <span className={styles.small}>{decision.actorType === "ai" ? "Proposée par l’IA" : `Par ${decision.actorEmail ?? "un humain"}`} · confiance {decision.confidence} % · {when(decision.createdAt)}</span>
      </li>)}</ul> : <p className={styles.empty}>Aucune décision enregistrée.</p>}
    </Card>
    <Card title="Actions et effets" description="État enregistré de chaque action. Un effet « En attente » ou « En cours » n’est pas confirmé.">
      {actions.length ? <ul className={styles.rows}>{actions.map(action => <li key={action.id}>
        <div className={styles.rowHead}><strong>{savLabel(savActionLabels, action.kind)}</strong><Status tone={actionTone(action.status)}>{savLabel(savActionStatusLabels, action.status)}</Status></div>
        <span className={styles.small}>Créée {when(action.createdAt)}{action.executedAt ? ` · exécutée ${when(action.executedAt)}` : ""}{action.actorEmail ? ` · ${action.actorEmail}` : ""}{action.errorCode ? ` · code ${action.errorCode}` : ""}</span>
        {action.draftText ? <Collapsible summary="Brouillon préparé"><p className={styles.body}>{action.draftText}</p></Collapsible> : null}
        {action.noteText ? <Collapsible summary="Note interne"><p className={styles.body}>{action.noteText}</p></Collapsible> : null}
      </li>)}</ul> : <p className={styles.empty}>Aucune action enregistrée.</p>}
    </Card>
    <Card title="Brouillons" description="Toutes les versions sont conservées, y compris celles écrites par un humain.">
      {drafts.length ? <ul className={styles.rows}>{drafts.map(draft => <li key={draft.id}>
        <div className={styles.rowHead}><strong>Version {draft.revision}</strong><Badge>{draft.origin === "human" ? "Écrit par un humain" : "Proposé par l’IA"}</Badge>{draft.isCurrent ? <Badge tone="accent">Version courante</Badge> : null}</div>
        <span className={styles.small}>{draft.createdBy ?? "—"} · {when(draft.createdAt)}</span>
        <Collapsible summary="Lire le brouillon"><p className={styles.body}>{draft.text}</p></Collapsible>
      </li>)}</ul> : <p className={styles.empty}>Aucun brouillon enregistré.</p>}
    </Card>
    <p className={styles.small}>Statut du dossier à l’archivage : {savLabel(savThreadStatusLabels, thread.status)} · dernier message {when(thread.lastMessageAt)}{thread.hubspotTicketId ? ` · ticket HubSpot ${thread.hubspotTicketId}` : ""}{thread.aiPaused ? " · agent mis en pause sur ce dossier" : ""}.</p>
  </div>;
}
