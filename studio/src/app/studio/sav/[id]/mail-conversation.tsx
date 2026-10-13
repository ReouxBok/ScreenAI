"use client";

import { useId, useState } from "react";
import { formatParisDateTime } from "@/lib/paris-date";
import { splitSavMessageText } from "@/lib/sav/message-context";
import type { getSavThreadDetail } from "@/lib/sav/service";
import styles from "./thread.module.css";

type Message = NonNullable<Awaited<ReturnType<typeof getSavThreadDetail>>>["messages"][number];
type Messages = Array<Pick<Message, "id" | "receivedAt" | "createdAt" | "direction" | "fromEmail"> & { body: Pick<Message["body"], "text" | "attachments"> }>;
const dateFormat = { format: (value: Date) => formatParisDateTime(value, { dateStyle: "medium", timeStyle: "short" }) };

function EmailMessage({ message, text = message.body.text }: { message: Messages[number]; text?: string }) {
  return <article className={`sav-message ${message.direction} ${styles.message}`}>
    <header><strong>{message.fromEmail}</strong><time dateTime={message.receivedAt.toISOString()}>{dateFormat.format(message.receivedAt)}</time></header>
    <pre>{text}</pre>
    {Boolean(message.body.attachments?.length) && <details className={styles.attachments}><summary>{message.body.attachments?.length} pièce(s) jointe(s) — non analysée(s)</summary><p>{message.body.attachments?.map((attachment) => `${attachment.filename} (${attachment.mimeType})`).join(" · ")}. Vérification humaine nécessaire.</p></details>}
  </article>;
}

export function MailConversation({ messages }: { messages: Messages }) {
  const [expanded, setExpanded] = useState(false);
  const conversationId = useId();
  const newestFirst = [...messages].sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime() || b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
  const latestInbound = newestFirst.find((message) => message.direction === "inbound");
  const currentText = latestInbound ? splitSavMessageText(latestInbound.body.text).currentText : "";
  // Display-only extraction: the expanded view always uses the complete original
  // body, including text beyond the analysis splitter's limit and attachments.
  const canExpand = (!latestInbound && messages.length > 0) || messages.length > 1 || Boolean(latestInbound && currentText !== latestInbound.body.text.trim());
  const visibleMessages = latestInbound ? [latestInbound, ...newestFirst.filter(message => message.id !== latestInbound.id)] : newestFirst;
  return <section className={`card ${styles.mail}`} aria-labelledby="customer-mail-title">
    <div className={styles.mailHeading}><div><span className="eyebrow">Demande du client</span><h2 id="customer-mail-title">Dernier email reçu</h2></div><span>{messages.length} message{messages.length > 1 ? "s" : ""}</span></div>
    {canExpand && <button className={`secondary ${styles.conversationToggle}`} type="button" aria-expanded={expanded} aria-controls={conversationId} onClick={() => setExpanded(value => !value)}>{expanded ? "Réduire la conversation" : "Afficher toute la conversation"}</button>}
    <div id={conversationId} className={styles.historyMessages}>
      {expanded ? visibleMessages.map(message => <EmailMessage key={message.id} message={message}/>) : latestInbound ? <EmailMessage message={latestInbound} text={currentText || "Cet email contient uniquement un historique cité ou une signature. Affichez toute la conversation pour le consulter."}/> : <p>Aucun email entrant dans cette conversation.</p>}
    </div>
    {!expanded && canExpand && <p className={styles.conversationHint}>Les anciens messages, les citations et la signature sont repliés. Le texte intégral reste disponible.</p>}
  </section>;
}
