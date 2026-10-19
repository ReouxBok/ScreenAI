import type { ObservationEvent } from "./observation-source";
import type { SavStructuredProposal } from "./proposal";
export const SAV_CASE_EVALUATOR_REVISION="sav-case-evaluator.v1";
export type SavCaseAxis={axis:string;state:"observed"|"not_evaluable";value:string|number|null;evidenceRefs:string[];limitation:string};
/** Observable facts only: no correctness score from closure, copied text or politeness. */
export function measureSavCase(proposal:SavStructuredProposal|null,events:ObservationEvent[],input:{ticketId:string|null;closed:boolean;errors:string[];baselineAt:string;cycle:number}) {
 const after=events.filter(e=>e.occurredAt>=input.baselineAt),human=after.filter(e=>e.kind==="human_reply"||e.kind==="note");
 const copied=human.filter(e=>proposal?.replyDraft&&normalize(e.text)===normalize(proposal.replyDraft));
 const independent=human.filter(e=>!copied.includes(e));
 const corrections=after.filter(e=>e.kind==="dossier_review"),actions=after.filter(e=>e.kind==="action_confirmed");
 const axes:SavCaseAxis[]=[
  {axis:"human_corrections",state:"observed",value:corrections.length,evidenceRefs:corrections.map(e=>e.sourceRef),limitation:"Corrections datées à comparer ; aucune présomption de justesse humaine."},
  {axis:"confirmed_actions",state:actions.length?"observed":"not_evaluable",value:actions.length,evidenceRefs:actions.map(e=>e.sourceRef),limitation:"Résultats confirmés dans Studio, distincts des propositions et mises en file."},
  {axis:"ticket_retained",state:input.ticketId?"observed":"not_evaluable",value:input.ticketId?proposal?.routing.kind==="matched"?proposal.routing.ticketId===input.ticketId?"proposed_ticket_retained":"different_ticket_confirmed":"ticket_confirmed":null,evidenceRefs:[],limitation:"Le rattachement confirmé ne prouve pas la justesse du diagnostic."},
  {axis:"exchanges",state:"observed",value:after.filter(e=>["customer_reply","human_reply","ai_reply"].includes(e.kind)).length,evidenceRefs:after.filter(e=>["customer_reply","human_reply","ai_reply"].includes(e.kind)).map(e=>e.sourceRef),limitation:"Échanges synchronisés uniquement ; canaux manquants exclus."},
  {axis:"reopenings",state:"observed",value:input.cycle-1,evidenceRefs:[],limitation:"Cycles de ce suivi uniquement."},
  {axis:"response_delay_ms",state:independent.length?"observed":"not_evaluable",value:independent[0]?Math.max(0,Date.parse(independent[0].occurredAt)-Date.parse(input.baselineAt)):null,evidenceRefs:independent[0]?[independent[0].sourceRef]:[],limitation:"Délai calendaire, pas temps opérateur actif."},
  {axis:"resolution",state:"not_evaluable",value:input.closed?"closure_recorded":"open",evidenceRefs:[],limitation:"Clôture et note internes ne confirment pas seules une résolution."},
  ...["understanding","diagnosis","questions","solution","sources","writing"].map(axis=>({axis,state:"not_evaluable" as const,value:null,evidenceRefs:[],limitation:"Comparaison sémantique sourcée requise ; aucune note de similarité."})),
 ];
 return {revision:SAV_CASE_EVALUATOR_REVISION,axes,coverage:{events:events.length,independentHumanEvidence:independent.length,copiedReplies:copied.length,sourceErrors:input.errors},independent};
}
export function normalize(text:string){return text.normalize("NFKC").toLocaleLowerCase("fr").replace(/\s+/g," ").trim();}
export function explicitCustomerConfirmation(text:string){return !/\b(pas|non|not|never|encore|toujours|jamais|doesn.t|isn.t|ne)\b/i.test(text)&&/(?:^|[^a-zà-ÿ])(?:résolu|réglé|fonctionne|ça marche|resolved|works now)(?:$|[^a-zà-ÿ])/i.test(text);}
/** A note can describe an attempt. It never becomes resolved automatically. */
export function observedResolutionEvidence(events:ObservationEvent[],proposal:SavStructuredProposal|null){
 return events.filter(e=>["human_reply","note"].includes(e.kind)&&e.author&&!e.truncated&&e.text.trim().length>=20
  &&(!proposal?.replyDraft||normalize(e.text)!==normalize(proposal.replyDraft))
).at(-1)??null;
}
