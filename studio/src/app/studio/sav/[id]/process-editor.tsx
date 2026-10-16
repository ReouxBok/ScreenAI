"use client";
import { useState } from "react";
import type { SavStructuredProposal } from "@/lib/sav/proposal";
import { savHumanActionLabels, type SavHumanProcess } from "@/lib/sav/human-process";
import { savRequestNatureSchema } from "@/lib/sav/understanding";
import { savProcessLabels } from "@/lib/sav/labels";
import styles from "./proposal-review.module.css";

type Ticket = { id: string; subject: string; status: "open" | "closed" };
export function ProcessEditor({ proposal: p, tickets }: { proposal: SavStructuredProposal; tickets: Ticket[] }) {
  const initial = p.humanProcess;
  const matchedId = p.routing.kind === "matched" ? p.routing.ticketId : null;
  const [action, setAction] = useState<SavHumanProcess["action"]>(initial?.action ?? (matchedId ? tickets.find(ticket => ticket.id === matchedId)?.status === "closed" ? "reopen_ticket" : "link_ticket" : p.routing.kind === "none" ? p.decision.reasonCode.includes("commercial") || p.decision.reasonCode.includes("lead_") ? "commercial" : p.decision.reasonCode.includes("partnership") ? "partnership" : "no_ticket" : "create_ticket"));
  const [ticketId, setTicketId] = useState(initial?.ticketId ?? (p.routing.kind === "matched" ? p.routing.ticketId : ""));
  const [reason, setReason] = useState(initial?.reason ?? p.decision.explanation);
  const [confirmed, setConfirmed] = useState(false);
  const [understanding, setUnderstanding] = useState<SavHumanProcess["understanding"]>(() => initial?.understanding ?? {
    primaryRequestId: p.understanding?.primaryRequestId ?? p.understanding?.requests[0]?.id ?? "human-request-1",
    requests: p.understanding?.requests.length ? p.understanding.requests.map(r => ({ id: r.id, summary: r.summary, nature: r.nature, product: r.product ?? "", feature: r.feature ?? "" })) : [{ id: "human-request-1", summary: p.decision.explanation.slice(0,600), nature: "unknown", product: "", feature: "" }],
    relationship: p.understanding?.customerRelationship?.kind ?? "unknown",
    knownFacts: p.understanding?.knownFacts.map(f => f.text) ?? [], attemptedSteps: p.understanding?.attemptedSteps.map(f => f.text) ?? [], missingInformation: p.understanding?.missingInformation.map(f => f.text) ?? [],
  });
  const [steps, setSteps] = useState(() => p.process.map((step, index) => ({ ...step, key: `step-${index}` })));
  const selectedAction = ["link_ticket", "reopen_ticket"].includes(action);
  const ticketOptions = tickets.filter(t => action === "reopen_ticket" ? t.status === "closed" : t.status === "open");
  function updateRequest(index: number, patch: Partial<typeof understanding.requests[number]>) {
    setUnderstanding({ ...understanding, requests: understanding.requests.map((r,i) => i === index ? { ...r, ...patch } : r) }); setConfirmed(false);
  }
  function move(index: number, direction: number) {
    const next = [...steps], other = index + direction;
    [next[index], next[other]] = [next[other], next[index]]; setSteps(next); setConfirmed(false);
  }
  return <section className={styles.section} aria-label="Correction humaine du process">
    <h3>Compréhension corrigée par l’humain</h3>
    <p>La proposition initiale reste conservée. Ces corrections définissent le process à valider.</p>
    {understanding.requests.map((request,index) => <fieldset key={request.id}><legend>Demande {index+1}</legend>
      <label>Demande comprise<textarea required minLength={3} maxLength={600} value={request.summary} onChange={e => updateRequest(index,{ summary:e.target.value })}/></label>
      <label>Nature<select value={request.nature} onChange={e => updateRequest(index,{ nature:savRequestNatureSchema.parse(e.target.value) })}>{savRequestNatureSchema.options.map(n => <option key={n} value={n}>{({ technical:"Dysfonctionnement", account:"Compte et accès", integration:"Intégration", how_to:"Utilisation", financial_operation:"Opération financière", financial_data:"Informations financières", cancellation:"Résiliation", commercial:"Commercial", partnership:"Partenariat", callback:"Rappel", human_request:"Prise en charge humaine", security:"Sécurité", privacy:"Confidentialité", data_deletion:"Suppression de données", legal:"Juridique", acknowledgement:"Accusé de réception", non_support:"Hors support", unknown:"À qualifier" })[n]}</option>)}</select></label>
      <label>Produit<input maxLength={200} value={request.product} onChange={e => updateRequest(index,{ product:e.target.value })}/></label><label>Fonction concernée<input maxLength={200} value={request.feature} onChange={e => updateRequest(index,{ feature:e.target.value })}/></label>
      <label><input type="radio" name="humanPrimaryRequest" checked={understanding.primaryRequestId === request.id} onChange={() => { setUnderstanding({ ...understanding, primaryRequestId:request.id }); setConfirmed(false); }}/>Demande principale</label>
      <button type="button" className="secondary" disabled={understanding.requests.length === 1} onClick={() => { const next=understanding.requests.filter(r => r.id!==request.id); setUnderstanding({ ...understanding, requests:next, primaryRequestId:understanding.primaryRequestId===request.id ? next[0].id : understanding.primaryRequestId }); setConfirmed(false); }}>Supprimer cette demande</button>
    </fieldset>)}
    <button type="button" className="secondary" disabled={understanding.requests.length>=15} onClick={() => { setUnderstanding({ ...understanding, requests:[...understanding.requests,{ id:crypto.randomUUID(),summary:"",nature:"unknown",product:"",feature:"" }] }); setConfirmed(false); }}>Ajouter une demande</button>
    <label>Relation client<select value={understanding.relationship} onChange={e => { setUnderstanding({ ...understanding, relationship:e.target.value as typeof understanding.relationship }); setConfirmed(false); }}><option value="unknown">À confirmer</option><option value="existing_customer">Client existant</option><option value="prospect">Prospect avant achat</option></select></label>
    {([["knownFacts","Faits connus"],["attemptedSteps","Déjà essayé"],["missingInformation","Informations manquantes"]] as const).map(([key,label]) => <label key={key}>{label} · une ligne par élément<textarea maxLength={30000} value={understanding[key].join("\n")} onChange={e => { setUnderstanding({ ...understanding, [key]:e.target.value.split("\n") }); setConfirmed(false); }}/></label>)}
    <h3>Action principale</h3>
    <label>Action à préparer<select value={action} onChange={e => { setAction(e.target.value as typeof action); setTicketId(""); setConfirmed(false); }}>{Object.entries(savHumanActionLabels).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    {selectedAction && <label>Ticket concerné<select required value={ticketId} onChange={e => { setTicketId(e.target.value); setConfirmed(false); }}><option value="">Choisir un ticket de cette fiche</option>{ticketOptions.map(t => <option key={t.id} value={t.id}>{t.subject || "Ticket sans titre"} · {t.status === "closed" ? "Fermé" : "Ouvert"}</option>)}</select></label>}
    {action==="reopen_ticket" && <p>Fermé depuis 15 jours au plus : rouvrir. Au-delà : nouveau ticket. Le propriétaire est conservé et l’opération exacte sera présentée avant confirmation.</p>}
    {action==="commercial" && <p>Règle existante : pas de ticket SAV pour une demande commerciale pure ; modèle prospect validé s’il est disponible, réponse humaine distincte.</p>}
    {action==="partnership" && <p>Un aperçu de transfert au destinataire partenariat prévu sera proposé après validation. Aucun transfert par ce formulaire.</p>}
    <label>Justification du choix<textarea required minLength={20} maxLength={2000} value={reason} onChange={e => { setReason(e.target.value); setConfirmed(false); }}/></label>
    <label><input type="checkbox" required checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>J’ai vérifié la demande et le choix d’action ; {selectedAction ? "le ticket choisi couvre ce même problème." : action==="create_ticket" ? "la nouvelle création concerne un problème distinct des tickets ouverts." : "ce traitement correspond à la qualification corrigée."}</label>
    <h3>Étapes du process</h3>
    <input type="hidden" name="processCount" value={steps.length}/>
    {steps.map((step,index) => <fieldset key={step.key}><legend>Étape {index+1}</legend>
      <label>Type d’étape<select name={`processKind_${index}`} value={step.kind} onChange={e => { setSteps(steps.map((s,i) => i===index ? { ...s, kind:e.target.value as typeof s.kind } : s)); setConfirmed(false); }}>{Object.entries(savProcessLabels).filter(([kind]) => ["human_review","create_ticket","link_ticket","product_step","review_reply","verify_outcome"].includes(kind)).map(([kind,label]) => <option key={kind} value={kind}>{label}</option>)}</select></label>
      <input type="hidden" name={`processSources_${index}`} value={JSON.stringify(step.sourceIds)}/>
      <label>Instruction<textarea name={`processLabel_${index}`} required minLength={3} maxLength={2000} value={step.label} onChange={e => { setSteps(steps.map((s,i) => i===index ? { ...s,label:e.target.value } : s)); setConfirmed(false); }}/></label>
      <div className="decision-buttons"><button type="button" className="secondary" disabled={!index} onClick={() => move(index,-1)}>Monter</button><button type="button" className="secondary" disabled={index===steps.length-1} onClick={() => move(index,1)}>Descendre</button><button type="button" className="secondary" disabled={steps.length===1} onClick={() => { setSteps(steps.filter((_,i) => i!==index)); setConfirmed(false); }}>Supprimer l’étape</button></div>
    </fieldset>)}
    <button type="button" className="secondary" disabled={steps.length>=30} onClick={() => { setSteps([...steps,{ key:crypto.randomUUID(),kind:"product_step",label:"",sourceIds:[] }]); setConfirmed(false); }}>Ajouter une étape</button>
    <p>Les étapes décrivent le travail à suivre. Seule l’action principale confirmée peut produire une commande CRM ou un transfert.</p>
    <input type="hidden" name="humanProcess" value={JSON.stringify({ action,ticketId:selectedAction ? ticketId || null : null,reason,confirmed,understanding:{ ...understanding,knownFacts:understanding.knownFacts.map(x=>x.trim()).filter(Boolean),attemptedSteps:understanding.attemptedSteps.map(x=>x.trim()).filter(Boolean),missingInformation:understanding.missingInformation.map(x=>x.trim()).filter(Boolean) } })}/>
    <input type="hidden" name="decisionKind" value={["commercial","partnership","no_ticket"].includes(action) ? "no_ticket_needed" : "human_review_required"}/>
  </section>;
}
