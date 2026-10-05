import type { getSavThreadDetail } from "@/lib/sav/service";
import styles from "./thread.module.css";

type Messages = NonNullable<Awaited<ReturnType<typeof getSavThreadDetail>>>["messages"];
const dateFormat = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });

function EmailMessage({ message }: { message: Messages[number] }) {
  return <article className={`sav-message ${message.direction} ${styles.message}`}>
    <header><strong>{message.fromEmail}</strong><time dateTime={message.receivedAt.toISOString()}>{dateFormat.format(message.receivedAt)}</time></header>
    <pre>{message.body.text}</pre>
    {Boolean(message.body.attachments?.length) && <p className="login-notice">Pièces jointes non analysées : {message.body.attachments?.map((attachment) => `${attachment.filename} (${attachment.mimeType})`).join(" · ")}. Vérification humaine nécessaire.</p>}
  </article>;
}

export function MailConversation({ messages }: { messages: Messages }) {
  const latestInbound = [...messages].reverse().find((message) => message.direction === "inbound");
  return <section className={`card ${styles.mail}`} aria-labelledby="customer-mail-title">
    <div className={styles.mailHeading}><div><span className="eyebrow">Demande du client</span><h2 id="customer-mail-title">Email du client</h2></div><span>{messages.length} message{messages.length > 1 ? "s" : ""}</span></div>
    {latestInbound ? <EmailMessage message={latestInbound}/> : <p>Aucun email entrant dans cette conversation.</p>}
    {messages.length > 1 && <details className={styles.history}>
      <summary>Voir la conversation entière <span>({messages.length} messages)</span></summary>
      <div className={styles.historyMessages}>{messages.map((message) => <EmailMessage key={message.id} message={message}/>)}</div>
    </details>}
  </section>;
}
