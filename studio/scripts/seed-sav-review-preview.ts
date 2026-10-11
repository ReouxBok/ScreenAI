import {eq} from "drizzle-orm";
import {closeDb,requireDb} from "../src/db/client";
import {savMessages,savThreads,savResolutionObservations} from "../src/db/schema";
import {loadSavDraftContext,reviewSavDraft} from "../src/lib/sav/draft-verdicts";
import {syncSavObservation} from "../src/lib/sav/observations";
if(process.env.NODE_ENV==="production" || !process.env.DATABASE_URL?.startsWith("pglite:") || !process.env.DATABASE_URL.endsWith("/sav-preview-db") || process.env.SAV_WRITES_DISABLED!=="true" || process.env.HUBSPOT_ACCESS_TOKEN || process.env.GMAIL_REFRESH_TOKEN)throw new Error("ISOLATED_SAV_PREVIEW_REQUIRED");
try{
 const db=requireDb();const [message]=await db.select().from(savMessages).where(eq(savMessages.gmailMessageId,"sav-preview-v0-identite"));
 if(message){
  await db.update(savThreads).set({hubspotTicketId:"990039"}).where(eq(savThreads.id,message.threadId));
  let [observation]=await db.select().from(savResolutionObservations).where(eq(savResolutionObservations.messageId,message.id));
  if(!observation){const c=await loadSavDraftContext(message.id);const v=await reviewSavDraft({threadId:message.threadId,messageId:message.id,decisionId:c.decision.id,agentRunId:c.run.id,sourceHash:c.sourceHash,expectedVerdictId:null,status:"rejected",reason:"Démo : la réponse humaine réelle mérite une qualification distincte."},"ugo@limova.ai");[observation]=await db.select().from(savResolutionObservations).where(eq(savResolutionObservations.verdictId,v.id));}
  await syncSavObservation(observation.id,async()=>({ticketId:"990039",status:"closed",subject:"Démo — résolution humaine observée",updatedAt:"2026-10-08T12:00:00Z",errors:[],events:[
   {sourceRef:"hubspot:emails:99003901",kind:"human_reply",occurredAt:"2026-10-08T11:00:00Z",text:"Démo fictive : le client peut retrouver son adresse d’inscription dans son email de bienvenue, puis ouvrir la page de connexion. Aucun parcours métier réel n’est validé ici.",author:"Équipe fictive",provenance:"Association HubSpot simulée",associationTicketId:"990039",remoteUpdatedAt:"2026-10-08T11:00:00Z"},
   {sourceRef:"hubspot:notes:99003902",kind:"note",occurredAt:"2026-10-08T11:30:00Z",text:"Démo : vérification humaine fictive du compte. Une note seule doit être qualifiée comme preuve effective.",author:"Équipe fictive",provenance:"Association HubSpot simulée",associationTicketId:"990039",remoteUpdatedAt:"2026-10-08T11:30:00Z"},
   {sourceRef:"hubspot:tasks:99003903",kind:"task",occurredAt:"2026-10-08T11:45:00Z",text:"Tâche fictive marquée terminée. Ce statut ne prouve pas une opération exécutée.",author:"Équipe fictive",provenance:"Association HubSpot simulée",associationTicketId:"990039",remoteUpdatedAt:"2026-10-08T11:45:00Z"}
  ]}));
 }
 console.log("Démo SAV-38/39 prête : verdict indépendant et bilan humain fictif, aucun accès fournisseur.");
}finally{await closeDb();}
