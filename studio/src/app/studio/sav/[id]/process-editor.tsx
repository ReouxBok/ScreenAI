"use client";
import { useState } from "react";
import type { SavStructuredProposal } from "@/lib/sav/proposal";
import { savHumanActionLabels, savSuggestedTicketTitle, type SavHumanProcess } from "@/lib/sav/human-process";
import { savRequestNatureSchema } from "@/lib/sav/understanding";
import { savCategoryLabels, savLabel, savUrgencyLabels } from "@/lib/sav/labels";
import styles from "./dossier.module.css";

type Ticket = { id: string; subject: string; status: "open" | "closed"; stageId?: string | null; ownerName?: string | null; ownerId?: string | null };
type Action = SavHumanProcess["action"];
const natureLabels: Record<string, string> = { technical:"Dysfonctionnement", account:"Compte et accès", integration:"Intégration", how_to:"Utilisation", financial_operation:"Opération financière", financial_data:"Informations financières", cancellation:"Résiliation", commercial:"Commercial", partnership:"Partenariat", callback:"Rappel", human_request:"Prise en charge humaine", security:"Sécurité", privacy:"Confidentialité", data_deletion:"Suppression de données", legal:"Juridique", acknowledgement:"Accusé de réception", non_support:"Hors support", unknown:"À qualifier" };
const stageLabels: Record<string, string> = { "1": "Nouveau", "2": "En attente du client", "3": "En attente de l’équipe" };
const confirmations: Record<Action, string> = {
  create_ticket: "J’ai vérifié la demande : c’est un problème distinct des tickets ouverts.",
  link_ticket: "J’ai vérifié que le ticket choisi couvre ce même problème.",
  reopen_ticket: "J’ai vérifié que le ticket fermé choisi couvre ce même problème.",
  partnership: "J’ai vérifié qu’il s’agit d’une demande de partenariat.",
  commercial: "J’ai vérifié qu’il s’agit d’une demande commerciale avant achat.",
  no_ticket: "J’ai vérifié qu’aucun ticket n’est nécessaire.",
};

function defaultAction(p: SavStructuredProposal, tickets: Ticket[]): Action {
  if (p.humanProcess) return p.humanProcess.action;
  if (p.routing.kind === "matched") { const matched = p.routing.ticketId; return tickets.find(ticket => ticket.id === matched)?.status === "closed" ? "reopen_ticket" : "link_ticket"; }
  if (p.routing.kind === "none") return p.decision.reasonCode.includes("commercial") || p.decision.reasonCode.includes("lead_") ? "commercial" : p.decision.reasonCode.includes("partnership") ? "partnership" : "no_ticket";
  return "create_ticket";
}

/** Human correction of the dossier. Only the confirmed main action can produce a CRM command or a transfer, after a separate preview. */
export function ProcessEditor({ proposal: p, tickets }: { proposal: SavStructuredProposal; tickets: Ticket[] }) {
  const [manualChoice, setManualChoice] = useState(false);
  const waitingIdentity = !p.humanProcess && p.routing.kind === "review" && (["registration_email_required", "registration_lookup_unavailable", "registration_email_confirmation_required"].includes(p.decision.reasonCode)
    || p.routing.reason === "registration_email_confirmation_required");
  if (waitingIdentity && !manualChoice) return <>
    <div className={styles.panel} role="status">
      <h3 className={styles.blockTitle}>Identifier le compte avant toute action</h3>
      <p>{p.decision.explanation}</p>
      <p>Aucune création, aucun rattachement ni aucune réouverture de ticket n’est proposé à ce stade. Le brouillon reste à relire et à valider séparément.</p>
      <button type="button" className="secondary" onClick={() => setManualChoice(true)}>Choisir manuellement une action après vérification du compte</button>
    </div>
    <input type="hidden" name="title" value={savSuggestedTicketTitle(p)}/>
    <input type="hidden" name="description" value={p.ticket.description}/>
    <input type="hidden" name="category" value={p.category}/><input type="hidden" name="urgency" value={p.urgency}/>
    <input type="hidden" name="decisionKind" value={p.decision.kind}/>
    <input type="hidden" name="processCount" value={p.process.length}/>
    {p.process.map((step, index) => <span key={index} hidden><input type="hidden" name={`processKind_${index}`} value={step.kind}/><input type="hidden" name={`processLabel_${index}`} value={step.label}/><input type="hidden" name={`processSources_${index}`} value={JSON.stringify(step.sourceIds)}/></span>)}
    <div className={styles.panel}><label><input type="checkbox" required/>J’ai relu la demande et l’étape de vérification du compte.</label></div>
  </>;
  return <EditableProcessEditor proposal={p} tickets={tickets}/>;
}

function EditableProcessEditor({ proposal: p, tickets }: { proposal: SavStructuredProposal; tickets: Ticket[] }) {
  const initial = p.humanProcess;
  const [action, setAction] = useState<Action>(() => defaultAction(p, tickets));
  const [ticketId, setTicketId] = useState(initial?.ticketId ?? (p.routing.kind === "matched" ? p.routing.ticketId : ""));
  const [ticketQuery, setTicketQuery] = useState("");
  const [reason, setReason] = useState(initial?.reason ?? p.decision.explanation);
  const [confirmed, setConfirmed] = useState(false);
  const [understanding, setUnderstanding] = useState<SavHumanProcess["understanding"]>(() => initial?.understanding ?? {
    primaryRequestId: p.understanding?.primaryRequestId ?? p.understanding?.requests[0]?.id ?? "human-request-1",
    requests: p.understanding?.requests.length ? p.understanding.requests.map(r => ({ id: r.id, summary: r.summary, nature: r.nature, product: r.product ?? "", feature: r.feature ?? "" })) : [{ id: "human-request-1", summary: p.decision.explanation.slice(0,600), nature: "unknown", product: "", feature: "" }],
    relationship: p.understanding?.customerRelationship?.kind ?? "unknown",
    knownFacts: p.understanding?.knownFacts.map(f => f.text) ?? [], attemptedSteps: p.understanding?.attemptedSteps.map(f => f.text) ?? [], missingInformation: p.understanding?.missingInformation.map(f => f.text) ?? [],
  });
  const selectsTicket = action === "link_ticket" || action === "reopen_ticket";
  const createsTicket = action === "create_ticket" || action === "reopen_ticket";
  const ticketOptions = tickets.filter(t => action === "reopen_ticket" ? t.status === "closed" : t.status === "open");
  const filteredTickets = ticketOptions.filter(ticket => `${ticket.id} ${ticket.subject} ${ticket.ownerName ?? ""} ${ticket.ownerId ?? ""}`.toLocaleLowerCase("fr").includes(ticketQuery.trim().toLocaleLowerCase("fr")));
  const change = () => setConfirmed(false);
  function updateRequest(index: number, patch: Partial<typeof understanding.requests[number]>) {
    setUnderstanding({ ...understanding, requests: understanding.requests.map((r,i) => i === index ? { ...r, ...patch } : r) }); change();
  }
  return <>
    <div className={styles.panel}>
      <details id="sav-correct-understanding" className={styles.optional}>
        <summary>Corriger la compréhension<small>Demandes, nature, relation client, déjà connu, déjà essayé, à demander. La proposition initiale reste conservée.</small></summary>
        <div>
          {understanding.requests.map((request,index) => <fieldset key={request.id}><legend>Demande {index+1}</legend>
            <label>Demande comprise<textarea required minLength={3} maxLength={600} value={request.summary} onChange={e => updateRequest(index,{ summary:e.target.value })}/></label>
            <div className={styles.fields}>
              <label>Nature<select value={request.nature} onChange={e => updateRequest(index,{ nature:savRequestNatureSchema.parse(e.target.value) })}>{savRequestNatureSchema.options.map(n => <option key={n} value={n}>{natureLabels[n]}</option>)}</select></label>
              <label>Produit<input maxLength={200} value={request.product} onChange={e => updateRequest(index,{ product:e.target.value })}/></label>
              <label>Fonction concernée<input maxLength={200} value={request.feature} onChange={e => updateRequest(index,{ feature:e.target.value })}/></label>
            </div>
            <label><input type="radio" name="humanPrimaryRequest" checked={understanding.primaryRequestId === request.id} onChange={() => { setUnderstanding({ ...understanding, primaryRequestId:request.id }); change(); }}/>Demande principale</label>
            {understanding.requests.length > 1 && <button type="button" className="secondary" onClick={() => { const next=understanding.requests.filter(r => r.id!==request.id); setUnderstanding({ ...understanding, requests:next, primaryRequestId:understanding.primaryRequestId===request.id ? next[0].id : understanding.primaryRequestId }); change(); }}>Retirer cette demande</button>}
          </fieldset>)}
          <button type="button" className="secondary" disabled={understanding.requests.length>=15} onClick={() => { setUnderstanding({ ...understanding, requests:[...understanding.requests,{ id:crypto.randomUUID(),summary:"",nature:"unknown",product:"",feature:"" }] }); change(); }}>Ajouter une demande</button>
          <label>Relation client<select value={understanding.relationship} onChange={e => { setUnderstanding({ ...understanding, relationship:e.target.value as typeof understanding.relationship }); change(); }}><option value="unknown">À confirmer</option><option value="existing_customer">Client existant</option><option value="prospect">Prospect avant achat</option></select></label>
          {([["knownFacts","Déjà connu"],["attemptedSteps","Déjà essayé"],["missingInformation","À demander"]] as const).map(([key,label]) => <label key={key}>{label} · une ligne par élément<textarea maxLength={30000} value={understanding[key].join("\n")} onChange={e => { setUnderstanding({ ...understanding, [key]:e.target.value.split("\n") }); change(); }}/></label>)}
        </div>
      </details>

      <fieldset className={styles.actions}><legend className={styles.blockTitle}>Que faire de ce dossier ?</legend>
        {(Object.entries(savHumanActionLabels) as [Action, string][]).map(([key,label]) => <label key={key} className={styles.action}><input type="radio" name="humanAction" value={key} checked={action === key} onChange={() => { setAction(key); setTicketId(""); setTicketQuery(""); change(); }}/>{label}</label>)}
      </fieldset>
      <label className={styles.why}>Pourquoi ce choix<textarea required minLength={20} maxLength={2000} value={reason} onChange={e => { setReason(e.target.value); change(); }}/></label>
    </div>

    {selectsTicket && <div className={styles.panel}>
      <h3 className={styles.blockTitle}>{action === "reopen_ticket" ? "Ticket fermé concerné" : "Ticket ouvert concerné"}</h3>
      <label>Rechercher le ticket concerné<input type="search" value={ticketQuery} onChange={e => setTicketQuery(e.target.value)} placeholder="Titre, numéro ou propriétaire"/></label>
      {ticketOptions.length ? <div className={styles.ticketChoices} role="radiogroup" aria-label="Ticket concerné">{ticketOptions.map(t => <div key={t.id} hidden={!filteredTickets.includes(t)}><label className={styles.ticketChoice}>
        <input type="radio" name="humanTicket" value={t.id} required checked={ticketId === t.id} onChange={() => { setTicketId(t.id); change(); }}/>
        <span><strong>{t.subject || "Ticket sans titre"}</strong><small>{t.status === "closed" ? "Fermé" : stageLabels[t.stageId ?? ""] ?? "Ouvert"} · {t.ownerName ? t.ownerName : t.ownerId ? "Propriétaire non résolu" : "Non assigné"}</small></span>
      </label></div>)}{!filteredTickets.length && <p className={styles.hint}>Aucun ticket ne correspond à cette recherche.</p>}</div> : <p className={styles.hint}>Aucun ticket {action === "reopen_ticket" ? "fermé" : "ouvert"} sur cette fiche. Choisissez une autre action.</p>}
      {action === "link_ticket" && <p className={styles.hint}>Si le ticket est déjà en Nouveau, il est rattaché sans changement. Sinon il repasse en Nouveau, avec le retour du client en note ; son propriétaire est conservé. L’opération exacte est présentée avant confirmation.</p>}
      {action === "reopen_ticket" && <ul className={styles.rules}>
        <li><span className={`${styles.badge} ${styles.done}`}>≤ 15 jours</span>Réouvrir en Nouveau, note de retour, propriétaire conservé</li>
        <li><span className={`${styles.badge} ${styles.todo}`}>&gt; 15 jours</span>Nouveau ticket avec le même propriétaire (paramètres ci-dessous)</li>
        <li><span className={`${styles.badge} ${styles.alert}`}>Date inconnue</span>Vérifier dans HubSpot, aucune action possible</li>
      </ul>}
    </div>}

    {action === "partnership" && <div className={styles.panel}><p className={styles.hint}>Aucun ticket. Après validation, un aperçu du transfert de l’email à nathan@limova.ai est proposé, sans le client en copie. Rien n’est envoyé par ce formulaire.</p></div>}
    {action === "commercial" && <div className={styles.panel}><p className={styles.hint}>Aucun ticket support. Le brouillon reprend le modèle de réponse validé s’il est disponible, sans réécriture par l’IA ; sinon qualification humaine.</p></div>}
    {action === "no_ticket" && <div className={styles.panel}><p className={styles.hint}>Aucun ticket. La justification ci-dessus est conservée dans le journal.</p></div>}

    {/* Ticket fields are always submitted (server contract); they are shown and required only when a new ticket can result. */}
    <div className={styles.panel} hidden={!createsTicket}>
      <h3 className={styles.blockTitle}>{action === "reopen_ticket" ? "Si un nouveau ticket est créé (> 15 jours)" : "Paramètres du ticket"}</h3>
      <label>Titre (4 à 6 mots)<input name="title" defaultValue={savSuggestedTicketTitle(p)} required={createsTicket} maxLength={500}/></label>
      <div className={styles.fields}>
        <label>Catégorie<select name="category" defaultValue={p.category}>{["technical", "account", "billing", "integration", "how_to", "acknowledgement", "other"].map(value => <option key={value} value={value}>{savLabel(savCategoryLabels, value)}</option>)}</select></label>
        <label>Priorité<select name="urgency" defaultValue={p.urgency}>{["low", "normal", "high", "critical"].map(value => <option key={value} value={value}>{savLabel(savUrgencyLabels, value)}</option>)}</select></label>
      </div>
      <p className={styles.fixed}><span>Pipeline <strong>Support</strong></span><span>Statut <strong>Nouveau</strong></span><span>Propriétaire <strong>{action === "reopen_ticket" ? "Celui du ticket fermé" : "Non assigné"}</strong></span><span>Source <strong>Email</strong></span></p>
      <label>Description<textarea name="description" defaultValue={p.ticket.description} required={createsTicket} rows={5}/></label>
    </div>

    <div className={styles.panel}>
      <label><input type="checkbox" required checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>{confirmations[action]}</label>
    </div>

    {/* The proposed process stays part of the reviewed snapshot; it is no longer reordered by hand. */}
    <input type="hidden" name="processCount" value={p.process.length}/>
    {p.process.map((step, index) => <span key={index} hidden>
      <input type="hidden" name={`processKind_${index}`} value={step.kind}/>
      <input type="hidden" name={`processLabel_${index}`} value={step.label}/>
      <input type="hidden" name={`processSources_${index}`} value={JSON.stringify(step.sourceIds)}/>
    </span>)}
    <input type="hidden" name="humanProcess" value={JSON.stringify({ action,ticketId:selectsTicket ? ticketId || null : null,reason,confirmed,understanding:{ ...understanding,knownFacts:understanding.knownFacts.map(x=>x.trim()).filter(Boolean),attemptedSteps:understanding.attemptedSteps.map(x=>x.trim()).filter(Boolean),missingInformation:understanding.missingInformation.map(x=>x.trim()).filter(Boolean) } })}/>
    <input type="hidden" name="decisionKind" value={["commercial","partnership","no_ticket"].includes(action) ? "no_ticket_needed" : "human_review_required"}/>
  </>;
}
