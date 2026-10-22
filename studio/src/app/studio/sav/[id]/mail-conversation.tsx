"use client";

import { useId, useState } from "react";
import { formatParisDateTime } from "@/lib/paris-date";
import { savMailDisplay } from "@/lib/sav/mail-display";
import type { getSavThreadDetail } from "@/lib/sav/service";
import type { SavTranslationView } from "@/lib/sav/translations";
import styles from "./thread.module.css";
import { AttachmentObservations } from "./attachment-observations";

type Message = NonNullable<Awaited<ReturnType<typeof getSavThreadDetail>>>["messages"][number];
type AttachmentView = Pick<NonNullable<Message["body"]["attachmentRead"]>, "readerRevision" | "observations">;
type Messages = Array<Pick<Message, "id" | "receivedAt" | "createdAt" | "direction" | "fromEmail"> & { translation?: SavTranslationView; body: Pick<Message["body"], "text" | "attachments" | "attachmentInventory"> & { attachmentRead?: AttachmentView | null } }>;
const dateFormat = { format: (value: Date) => formatParisDateTime(value, { dateStyle: "medium", timeStyle: "short" }) };

function EmailMessage({ message, text = message.body.text }: { message: Messages[number]; text?: string }) {
  const [showOriginal,setShowOriginal]=useState(false);
  const translation=message.translation,translated=translation?.status==="complete"&&Boolean(translation.text),languages:Record<string,string>={en:"l’anglais",es:"l’espagnol",de:"l’allemand",it:"l’italien",pt:"le portugais"};
  return <article className={`sav-message ${message.direction} ${styles.message}`}>
    <header><strong>{message.fromEmail}</strong><time dateTime={message.receivedAt.toISOString()}>{dateFormat.format(message.receivedAt)}</time></header>
    {translated&&<p role="status">Ce mail a été traduit de {languages[translation!.language]??"sa langue d’origine"}. <button type="button" className="secondary" onClick={()=>setShowOriginal(value=>!value)}>{showOriginal?"Voir la traduction":"Voir l’original"}</button></p>}
    {translation&&!translated&&translation.status!=="not_required"&&<p role="status">Original affiché · {({pending:translation.errorCode?.startsWith("SAV_DERIVED_")?"traduction en attente du budget · reprise automatique":"traduction en préparation",partial:"traduction partielle non affichée",unsupported:"langue mixte, incertaine ou non prise en charge",unavailable:"traduction indisponible",not_prepared:"traduction non préparée"} as Record<string,string>)[translation.status]??"traduction non disponible"}.</p>}
    <pre>{translated?(showOriginal?message.body.text:translation!.text):text}</pre>
    <AttachmentObservations attachments={message.body.attachments} inventory={message.body.attachmentInventory} read={message.body.attachmentRead}/>
  </article>;
}

export function MailConversation({ messages, embedded = false }: { messages: Messages; embedded?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const conversationId = useId();
  const newestFirst = [...messages].sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime() || b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
  const latestInbound = newestFirst.find((message) => message.direction === "inbound");
  const display = latestInbound ? savMailDisplay(latestInbound.body.text) : null;
  const currentText = display?.text ?? "";
  // Display-only extraction: the expanded view always uses the complete original
  // body, including text beyond the analysis splitter's limit and attachments.
  const canExpand = (!latestInbound && messages.length > 0) || messages.length > 1 || Boolean(display?.ambiguous || latestInbound && currentText !== latestInbound.body.text.trim());
  const visibleMessages = latestInbound ? [latestInbound, ...newestFirst.filter(message => message.id !== latestInbound.id)] : newestFirst;
  return <section className={embedded ? styles.mailEmbedded : `card ${styles.mail}`} {...embedded ? { "aria-label": "Emails du client" } : { "aria-labelledby": "customer-mail-title" }}>
    {!embedded && <div className={styles.mailHeading}><div><span className="eyebrow">Demande du client</span><h2 id="customer-mail-title">Dernier email reçu</h2></div><span>{messages.length} message{messages.length > 1 ? "s" : ""}</span></div>}
    {canExpand && <button className={`secondary ${styles.conversationToggle}`} type="button" aria-expanded={expanded} aria-controls={conversationId} onClick={() => setExpanded(value => !value)}>{expanded ? "Réduire la conversation" : `Afficher toute la conversation (${messages.length} message${messages.length > 1 ? "s" : ""})`}</button>}
    {!expanded && display?.warning && <p className={styles.conversationWarning} role="status">{display.warning}</p>}
    <div id={conversationId} className={`${styles.historyMessages} ${expanded ? styles.historyExpanded : ""}`} tabIndex={expanded ? 0 : undefined} role={expanded ? "region" : undefined} aria-label={expanded ? "Conversation complète avec défilement" : undefined}>
      {expanded ? visibleMessages.map(message => <EmailMessage key={message.id} message={message}/>) : latestInbound ? <EmailMessage message={latestInbound} text={currentText || "Cet email contient uniquement un historique cité ou une signature. Affichez toute la conversation pour le consulter."}/> : <p>Aucun email entrant dans cette conversation.</p>}
    </div>
    {!expanded && canExpand && !display?.ambiguous && <p className={styles.conversationHint}>Les anciens messages, les citations détectées et la signature sont repliés. L’extraction est automatique : le texte intégral reste disponible si une réponse est intercalée.</p>}
  </section>;
}
