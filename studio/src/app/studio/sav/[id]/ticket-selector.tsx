"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatParisDateTime } from "@/lib/paris-date";
import { sortSavTicketsNewestFirst, type SavLifecycleTicket } from "@/lib/sav/ticket-lifecycle";
import type { SavTicketPreview } from "@/lib/sav/manual-ticket-preview";
import type { SavHumanProcess } from "@/lib/sav/human-process";
import { prepareTicketPreviewAction, confirmTicketPreviewAction } from "../ticket-preview-actions";
import styles from "./ticket-selector.module.css";

type Ticket = SavLifecycleTicket & { subject: string; updatedAt?: string | null };
export function savTicketStageLabel(ticket: Pick<Ticket, "status" | "stageId">) {
  return ticket.status === "closed" ? "Fermé" : ({ "1": "Nouveau", "2": "En attente du client", "3": "En attente de l’équipe" } as Record<string, string>)[ticket.stageId ?? ""] ?? "Statut à vérifier";
}
export function TicketSelector({ threadId, reviewId, tickets, linkedTicketId, suggestedTicketId, newTicketTitle, crmReady, completed, pending, blockedReason, humanChoice }: {
  threadId: string; reviewId: string | null; tickets: Ticket[]; linkedTicketId: string | null; suggestedTicketId: string | null;
  newTicketTitle: string; crmReady: boolean; completed: boolean; pending: boolean; blockedReason?: string | null; humanChoice?: SavHumanProcess;
}) {
  const [selected, setSelected] = useState(suggestedTicketId ?? "new");
  const [query, setQuery] = useState("");
  const [reason, setReason] = useState(humanChoice?.reason ?? "");
  const [preview, setPreview] = useState<SavTicketPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const [busy, startTransition] = useTransition();
  const router = useRouter(), name = useId(), previewRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (preview) { previewRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); previewRef.current?.focus(); }
  }, [preview]);
  useEffect(() => {
    if ((!queued && !pending) || completed) return;
    let timer: ReturnType<typeof setTimeout>, stopped=false, attempts=0;
    const controller=new AbortController();
    async function poll() {
      try {
        const response=await fetch(`/api/internal/sav/dossiers/${threadId}/status`,{ cache:"no-store",signal:controller.signal });
        if (!response.ok) throw new Error();
        const state=await response.json();
        if (state.ticket && !["pending","running"].includes(state.ticket.status)) { setQueued(false);router.refresh();return; }
      } catch { if(controller.signal.aborted) return; }
      if (!stopped && ++attempts<100) timer=setTimeout(poll,3000);
    }
    void poll();return () => { stopped=true;controller.abort();clearTimeout(timer); };
  },[queued,pending,completed,threadId,router]);
  const filtered = sortSavTicketsNewestFirst(tickets).filter(ticket => `${ticket.subject} ${ticket.id} ${ticket.ownerId ?? ""} ${ticket.ownerName ?? ""}`.toLocaleLowerCase("fr").includes(query.toLocaleLowerCase("fr")));
  const disabled = !reviewId || !crmReady || completed || pending || queued || Boolean(blockedReason);
  function choose(value: string) { setSelected(value); setPreview(null); setError(null); }
  function prepare() {
    if (!reviewId) return;
    startTransition(async () => {
      setError(null); setPreview(null);
      try {
        const result = await prepareTicketPreviewAction({ threadId, reviewId, ...(selected === "new" ? {} : { ticketId: selected }), distinctIssueReason: reason });
        setError(result.error); setPreview(result.preview);
      } catch { setError("L’aperçu n’a pas pu être préparé. Vérifiez la connexion et réessayez."); }
    });
  }
  function confirm() {
    if (!preview) return;
    startTransition(async () => {
      try {
        const result = await confirmTicketPreviewAction(preview.token);
        setError(result.error);
        if (result.actionId) { setQueued(true); setPreview(null); router.refresh(); }
        else setPreview(null);
      } catch { setError("Le résultat de la confirmation n’est pas connu. Actualisez le dossier pour vérifier la file avant toute reprise."); setPreview(null); router.refresh(); }
    });
  }
  return <div className={styles.selector}>
    <h3>Choisir l’action ticket</h3>
    {linkedTicketId && <p><strong>Ticket réellement lié : {tickets.find(ticket => ticket.id === linkedTicketId)?.subject || "Ticket HubSpot"}</strong></p>}
    {suggestedTicketId && <p>Correspondance proposée : {tickets.find(ticket => ticket.id === suggestedTicketId)?.subject || "ticket HubSpot"}. Cette proposition ne rattache pas le dossier.</p>}
    {completed ? <p role="status">Action déjà traitée pour cet email.</p> : queued || pending ? <p role="status">Demande HubSpot en attente de confirmation. Consultez son résultat dans le journal d’actions.</p> : blockedReason ? <p role="status">{blockedReason}</p> : !reviewId ? <p>Validez d’abord le dossier / process pour choisir une action.</p> : !crmReady ? <p role="alert">Le contexte HubSpot est indisponible ou incomplet. Actualisez-le avant de choisir une action.</p> : null}
    {!completed && <>
      <label>Rechercher un ticket<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Titre, numéro ou propriétaire" disabled={busy}/></label>
      {humanChoice && <p>Choix issu du process validé. Pour changer l’action ou le ticket, corrigez puis revalidez le process ci-dessus.</p>}
      <fieldset disabled={disabled || busy || Boolean(humanChoice)}><legend>Tickets de la fiche client</legend>
        <div className={styles.options}>
          {filtered.map(ticket => <label className={styles.option} key={ticket.id}>
            <input type="radio" name={name} value={ticket.id} checked={selected === ticket.id} onChange={() => choose(ticket.id)}/>
            <span><strong>{ticket.subject || "Ticket sans titre"}</strong><small>{savTicketStageLabel(ticket)}</small><small>{formatParisDateTime(ticket.createdAt)} · {ticket.ownerName ? `Propriétaire : ${ticket.ownerName}` : ticket.ownerId ? "Propriétaire non résolu" : "Propriétaire non renseigné"}</small>
              {(ticket.id === linkedTicketId || ticket.id === suggestedTicketId) && <small>{ticket.id === linkedTicketId ? "Réellement lié" : "Correspondance proposée"}</small>}</span>
          </label>)}
          {crmReady && !filtered.length && <p>{tickets.length ? "Aucun ticket ne correspond à cette recherche." : "Aucun ticket retrouvé sur la fiche client."}</p>}
        </div>
        {!linkedTicketId && <label className={styles.option}><input type="radio" name={name} value="new" checked={selected === "new"} onChange={() => choose("new")}/><span><strong>Ouvrir un nouveau ticket</strong><small>{newTicketTitle}</small></span></label>}
      </fieldset>
      {selected === "new" && tickets.some(ticket => ticket.status === "open") && <label>Pourquoi est-ce un problème distinct ?<textarea value={reason} maxLength={2000} disabled={busy || disabled} onChange={event => { setReason(event.target.value); setPreview(null); }} placeholder="Justification d’au moins 20 caractères"/></label>}
      <p className={styles.hint}>La sélection ne modifie rien. Le même sujet, le statut et la fenêtre de 15 jours seront revérifiés avant l’action.</p>
      <button type="button" className="secondary" disabled={disabled || busy} onClick={prepare}>{busy ? "Vérification en cours…" : "Préparer l’aperçu de l’action"}</button>
    </>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {preview && <section ref={previewRef} tabIndex={-1} className={styles.preview} aria-label="Aperçu de l’action HubSpot">
      <span className="eyebrow">Confirmation explicite</span><h3>{preview.details.label} : {preview.details.title}</h3>
      <p>{preview.details.explanation}</p>
      <dl><dt>Cible</dt><dd>{preview.details.targetId ? preview.details.targetTitle || "Ticket HubSpot" : "Nouveau ticket"}</dd><dt>Fiche client</dt><dd>{preview.details.contactName || "Fiche HubSpot liée"}</dd>{preview.details.category && <><dt>Catégorie</dt><dd>{preview.details.category}</dd></>}{preview.details.priority && <><dt>Priorité</dt><dd>{({LOW:"Basse",MEDIUM:"Normale",HIGH:"Haute",URGENT:"Critique"} as Record<string,string>)[preview.details.priority] ?? preview.details.priority}</dd></>}{preview.details.ownerId && <><dt>Propriétaire conservé</dt><dd>{preview.details.ownerName || "Propriétaire non résolu"}</dd></>}</dl>
      {preview.details.note ? <><strong>Note exacte ajoutée</strong><blockquote>{preview.details.note}</blockquote><p>Aucun corps d’email recopié dans cette note.</p></> : preview.details.description ? <><strong>Description du nouveau ticket</strong><p className={styles.description}>{preview.details.description}</p></> : <p>Aucune note ajoutée et aucun changement de statut.</p>}
      <p className={styles.hint}>Aperçu valable jusqu’à {formatParisDateTime(new Date(preview.expiresAt), { timeStyle: "short" })}. Une modification du contexte impose un nouvel aperçu.</p>
      <button type="button" className="primary" disabled={busy || disabled} onClick={confirm}>{busy ? "Confirmation en cours…" : `Confirmer : ${preview.details.label.toLocaleLowerCase("fr")}`}</button>
      <button type="button" className="secondary" disabled={busy} onClick={() => setPreview(null)}>Annuler</button>
    </section>}
  </div>;
}
