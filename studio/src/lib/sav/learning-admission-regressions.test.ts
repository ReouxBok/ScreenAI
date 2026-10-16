import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createSavTestDb } from '../../../test/sav-db';
import { contentItems, contentVersions, contentChunks, categories, savLearningCandidates, savLearningAdmissionReservations, savLearningAdmissionSignals, savLearningAdmissionAttempts, savResolutionEvidence, savSyncState, savTicketSnapshots } from '@/db/schema';
import { processSavLearningResolution, savLearningProofHash } from './learning-pipeline';
import { activateSavLearningCutover, recordSavLearningSignal, reserveSavLearningCapacityTx, savLearningAdmissionMetrics, claimSavLearningComparisonTx, finishSavLearningComparisonTx, SAV_LEARNING_COMPARISON_LEASE_MS } from './learning-admission';
import { approveLearningCandidate, rejectLearningCandidate } from './learning';
import { activateSavKnowledgeVersion } from '@/lib/knowledge/activation';
import { backfillHubspotTickets } from './hubspot';
import { paginateSavKnowledge } from '@/lib/knowledge/workspace';
import { decryptSavPayload, encryptSavPayload } from './crypto';

const state=vi.hoisted(()=>({db:null as unknown, inventory:[] as Array<{ref:string;versionId:string;title:string;body:string}>, payloads:[] as Record<string,unknown>[], match:null as string|null, beforeResponse:null as null|(()=>Promise<void>)}));
vi.mock('@/db',()=>({requireDb:()=>state.db}));
vi.mock('@/lib/knowledge/hubspot-import',async(importOriginal)=>({...await importOriginal<typeof import('@/lib/knowledge/hubspot-import')>(),knowledgeComparisonInventory:async()=>structuredClone(state.inventory)}));
let f:Awaited<ReturnType<typeof createSavTestDb>>;
const now=new Date('2026-10-15T12:00:00Z');
const boundary={activatedAt:'2026-10-14T12:00:00.000Z',activatedBy:'ugo@limova.ai' as const,deploymentSha:'a'.repeat(40)};
const resolution='Ouvrir les paramètres puis rétablir la connexion ; le contrôle humain confirme que la connexion fonctionne.';
function input(n:number,origin:'hubspot'|'observation'='hubspot') {return {ticketId:String(90000+n),sourceRef:`${origin}:${90000+n}`,origin,cycleStartedAt:'2026-10-15T10:00:00Z',snapshotId:`snapshot-${n}`,snapshotHash:`snapshot-hash-${n}`,subject:`Procédure fictive ${n}`,resolution,provenance:'human_resolution',sourceMessageId:`human-email-${n}`,customerConfirmed:true};}
const modelFetch=vi.fn(async(_url:unknown,init?:RequestInit)=>{
 const request=JSON.parse(String(init?.body));const p=JSON.parse(request.contents[0].parts[0].text);state.payloads.push(p);
 if(state.beforeResponse)await state.beforeResponse();
 const decision={outcome:state.match?'amendment':'new',matchedRef:state.match,groupSignature:p.subject,subject:p.subject,resolution:p.resolution,conditions:['Connexion du produit fictif uniquement'],expectedResult:'La connexion est rétablie',limitations:['Escalader si la connexion échoue'],evidenceRef:p.evidence.ref,evidenceExcerpt:p.resolution.slice(0,80),rationale:'Action humaine observée et résultat reproductible dans ce cas synthétique.'};
 return new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(decision)}]}}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:20}}));
});
async function run(i:ReturnType<typeof input>,at=now){
 if(i.origin==='hubspot') {
  await f.db.insert(savTicketSnapshots).values({hubspotTicketId:i.ticketId,status:'closed',subject:i.subject,transcriptCiphertext:encryptSavPayload({transcript:[]}),contentHash:i.snapshotHash,humanIntervened:true,learningCycleStartedAt:new Date(i.cycleStartedAt),hubspotUpdatedAt:now}).onConflictDoNothing();
  const [snapshot]=await f.db.select().from(savTicketSnapshots).where(eq(savTicketSnapshots.hubspotTicketId,i.ticketId));
  i={...i,snapshotId:snapshot.id};
 }
 return processSavLearningResolution(i,{now:at,apiKey:'synthetic-only-key',model:'synthetic-comparator',fetch:modelFetch as typeof fetch});
}
beforeAll(async()=>{f=await createSavTestDb();state.db=f.db;},30000);
afterAll(async()=>{await f?.client.close();});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();});
beforeEach(async()=>{
 await f.client.exec('TRUNCATE sav.learning_candidates, sav.learning_admission_signals, sav.learning_admission_stats, sav.learning_admission_reservations, sav.learning_admission_cases, sav.learning_model_usage, sav.sync_state, sav.ticket_snapshots, content_items, categories, audit_logs, active_knowledge, knowledge_revisions CASCADE');
 vi.stubEnv('SAV_ENCRYPTION_KEY_V1','independent-review-synthetic-key-2026');vi.stubEnv('SAV_GEMINI_API_KEY','synthetic-only-key');vi.stubEnv('SAV_RELEASE_STAGE','v0');vi.stubEnv('HUBSPOT_ACCESS_TOKEN','synthetic-only-token');
 vi.stubGlobal('fetch',()=>{throw new Error('UNEXPECTED_NETWORK');});
 state.inventory=[];state.payloads=[];state.match=null;state.beforeResponse=null;modelFetch.mockClear();
 await activateSavLearningCutover(boundary,'ugo@limova.ai');
});

it('caps CRM observation qualifications at five admissions',async()=>{
 for(let n=0;n<11;n++)expect(await run(input(n,'observation'))).toMatchObject(n<5?{disposition:'admitted'}:{disposition:'signal',reasonCode:'weekly_limit'});
 expect(await f.db.select().from(savLearningCandidates)).toHaveLength(5);
 expect(await f.db.select().from(savLearningAdmissionReservations)).toHaveLength(5);
 expect((await savLearningAdmissionMetrics()).openAutomaticProposals).toBe(5);
});

it('does not reopen a human rejection for identical evidence in another email',async()=>{
 const original=input(1);const first=await run(original);expect(first).toHaveProperty('candidateId');
 const firstId=String((first as {candidateId:string}).candidateId);await rejectLearningCandidate(firstId,'ugo@limova.ai');
 const second=await run({...original,sourceMessageId:'human-email-same-text-duplicate'});
 expect(second).toMatchObject({disposition:'signal',reasonCode:'rejected_unchanged_proof'});
 const rows=await f.db.select().from(savLearningCandidates);expect(rows).toHaveLength(1);expect(rows[0].status).toBe('rejected');expect(modelFetch).toHaveBeenCalledTimes(1);
});

it('keeps a quota refusal terminal after journal eviction and capacity reset',async()=>{
 for(let n=0;n<5;n++)await f.db.transaction(tx=>reserveSavLearningCapacityTx(tx,{reservationKey:`fixture-capacity-${n}`,proposalKind:'new',now}));
 const original=input(20);expect(await run(original)).toMatchObject({disposition:'signal',reasonCode:'weekly_limit'});
 const later=new Date('2026-10-23T12:00:00Z');
 for(let n=0;n<100;n++)await recordSavLearningSignal({sourceRef:`hubspot:noise-${n}`,sourceHash:`noise-${n}`,origin:'hubspot',reasonCode:'insufficient_evidence'},new Date(later.getTime()+n));
 expect((await f.db.select().from(savLearningAdmissionSignals)).some(s=>s.sourceRef===original.sourceRef)).toBe(false);
 expect(await run(original,new Date(later.getTime()+1000))).toMatchObject({disposition:'duplicate',reasonCode:'weekly_limit'});
 expect(await f.db.select().from(savLearningCandidates)).toHaveLength(0);expect(modelFetch).toHaveBeenCalledTimes(1);
});

async function article(){
 const [item]=await f.db.insert(contentItems).values({type:'article',slug:'synthetic-support',title:'Support fictif',ownerEmail:'ugo@limova.ai',agentKey:'sav'}).returning();return item;
}

it('preserves two distinct amendments to the same article',async()=>{
 const item=await article();state.inventory=[{ref:`content:${item.id}`,versionId:'version-1',title:item.title,body:'Documentation synthétique de base.'}];state.match=`content:${item.id}`;
 expect(await run({...input(1),resolution:'Régénérer la clé API puis vérifier la reconnexion du produit fictif.'})).toMatchObject({disposition:'admitted'});
 expect(await run({...input(2),resolution:'Configurer le proxy réseau puis vérifier la reconnexion du produit fictif.'})).toMatchObject({disposition:'admitted'});
 const rows=await f.db.select().from(savLearningCandidates);expect(rows).toHaveLength(2);
 const texts=rows.map(row=>decryptSavPayload<{finalHumanResolution:string}>(String(row.proposedPatch.ciphertext)).finalHumanResolution);expect(texts.some(t=>t.includes('clé API'))).toBe(true);expect(texts.some(t=>t.includes('proxy'))).toBe(true);expect(rows.map(row=>row.evidenceCaseCount)).toEqual([1,1]);
});

it('keeps a pending amendment slot reserved when another version is activated',async()=>{
 const item=await article();const metadata={intents:['Support fictif'],limovaPaths:[],prerequisites:[],expectedResult:'Résultat fictif',troubleshooting:'Vérifier humainement.'};
 const [version]=await f.db.insert(contentVersions).values({itemId:item.id,version:1,bodyMarkdown:'Documentation synthétique initiale sans amendement.',metadata,changeNote:'Fixture',authorEmail:'ugo@limova.ai'}).returning();
 await f.db.update(contentItems).set({status:'published',publishedVersionId:version.id,currentDraftVersionId:version.id}).where(eq(contentItems.id,item.id));
 await f.db.insert(contentChunks).values({itemId:item.id,versionId:version.id,ordinal:0,content:version.bodyMarkdown,embedding:Array(768).fill(0)});
 state.inventory=[{ref:`content:${item.id}`,versionId:version.id,title:item.title,body:version.bodyMarkdown}];state.match=`content:${item.id}`;
 const admitted=await run(input(1));expect(admitted).toMatchObject({disposition:'admitted'});
 expect((await f.db.select().from(savLearningAdmissionReservations))[0].state).toBe('open');
 await activateSavKnowledgeVersion({itemId:item.id,expectedPublishedVersionId:version.id,expectedActiveVersionId:null},'ugo@limova.ai');
 expect((await f.db.select().from(savLearningCandidates))[0].status).toBe('pending');expect((await f.db.select().from(savLearningAdmissionReservations))[0].state).toBe('open');
});

it('blocks historical admission through direct approval and the canonical library',async()=>{
 await f.db.delete(savSyncState).where(eq(savSyncState.key,'sav-learning-admission-cutover'));
 await f.db.insert(categories).values({slug:'depannage',label:'Dépannage'});
 const [legacy]=await f.db.insert(savLearningCandidates).values({sourceRef:'hubspot:historical',sourceContentHash:'historical-before-cutover',createdBy:'system',createdAt:new Date('2026-10-01T12:00:00Z'),proposedPatch:{ciphertext:encryptSavPayload({subject:'Connexion fictive',finalHumanResolution:resolution,sourceSnapshotId:'old-snapshot',provenance:'human_resolution'})},explanation:'Stock historique synthétique'}).returning();
 expect((await paginateSavKnowledge({tab:'automatic'})).rows.some(row=>row.id===legacy.id)).toBe(false);
 await expect(approveLearningCandidate(legacy.id,'ugo@limova.ai')).rejects.toThrow('SAV_LEARNING_HISTORICAL_REVIEW_BLOCKED');expect((await f.db.select().from(savLearningCandidates))[0].status).toBe('pending');
});

it('blocks stale comparison after catalogue changes during the model call',async()=>{
 state.inventory=[{ref:'content:fixture',versionId:'old-version',title:'Notice initiale',body:'Absence de procédure.'}];
 state.beforeResponse=async()=>{state.inventory=[{ref:'content:fixture',versionId:'new-version-covering-procedure',title:'Notice complétée',body:resolution}];};
 expect(await run(input(1))).toMatchObject({disposition:'signal',reasonCode:'comparison_context_changed'});expect((state.payloads[0].activeKnowledge as Array<{versionId:string}>)[0].versionId).toBe('old-version');
});

it('blocks old pre-cutover evidence despite a later closing timestamp',async()=>{
 const old=new Date('2026-10-13T12:00:00Z');
 await f.db.insert(savTicketSnapshots).values({hubspotTicketId:'99991',status:'open',subject:'Ancien dossier fictif',transcriptCiphertext:encryptSavPayload({transcript:[]}),contentHash:'old',humanIntervened:true,hubspotUpdatedAt:old});
 const fake=vi.fn(async(url:unknown,init?:RequestInit)=>{
  const u=String(url);if(u.startsWith('https://generativelanguage.googleapis.com/'))return modelFetch(url,init);
  if(u.startsWith('https://api.hubapi.com/crm/v3/objects/tickets?'))return new Response(JSON.stringify({results:[{id:'99991',updatedAt:'2026-10-15T10:00:00Z',properties:{subject:'Ancien dossier fictif',hs_pipeline_stage:'closed',content:'Contenu ancien fictif'},associations:{emails:{results:[{id:'old-human-email'}]}}}]}));
  if(u==='https://api.hubapi.com/crm/v3/objects/emails/batch/read')return Response.json({results:[{id:'old-human-email',properties:{hs_email_text:resolution,hs_timestamp:'2026-10-13T10:00:00Z',hs_email_direction:'OUTGOING_EMAIL'}}]});
  if(u==='https://api.hubapi.com/crm/v3/pipelines/tickets')return new Response(JSON.stringify({results:[{stages:[{id:'closed',metadata:{ticketState:'CLOSED'}}]}]}));
  throw new Error('UNEXPECTED_MOCK_URL');
 });vi.stubGlobal('fetch',fake);
 expect(await backfillHubspotTickets({maxPages:1})).toMatchObject({processed:1});
 expect(await f.db.select().from(savLearningCandidates)).toHaveLength(0);expect(modelFetch).toHaveBeenCalledTimes(0);
});

it('does not lose an in-flight comparison when the display journal is pruned',async()=>{
 state.beforeResponse=async()=>{
  for(let n=0;n<101;n++)await recordSavLearningSignal({sourceRef:`hubspot:noise-${n}`,sourceHash:`noise-${n}`,origin:'hubspot',reasonCode:'insufficient_evidence'},new Date(now.getTime()+n+1));
 };
 const original=input(70);expect(await run(original)).toMatchObject({disposition:'admitted'});
 expect(await f.db.select().from(savLearningAdmissionSignals)).toHaveLength(100);
 expect(await f.db.select().from(savLearningAdmissionAttempts)).toHaveLength(102);
 expect(await run(original)).toMatchObject({disposition:'duplicate'});expect(modelFetch).toHaveBeenCalledTimes(1);
});

it('enforces ten open reservations even when the weekly window has expired',async()=>{
 for(let n=0;n<10;n++)await f.db.transaction(tx=>reserveSavLearningCapacityTx(tx,{reservationKey:`open-${n}`,proposalKind:'new',now:new Date(now.getTime()-(20-n)*86400000)}));
 // Those dates span two rolling windows; seed the remaining open capacity explicitly if a window refused it.
 const rows=await f.db.select().from(savLearningAdmissionReservations);
 for(let n=rows.length;n<10;n++)await f.db.insert(savLearningAdmissionReservations).values({reservationKey:`older-open-${n}`,proposalKind:'new',state:'open',createdAt:new Date('2026-09-01T12:00:00Z')});
 expect(await run(input(71))).toMatchObject({disposition:'signal',reasonCode:'open_limit'});
 expect(await f.db.select().from(savLearningCandidates)).toHaveLength(0);
});

it('groups four distinct dossiers with three displayed references and one reservation',async()=>{
 for(let n=0;n<4;n++)expect(await run({...input(80+n),subject:'Même procédure fictive'})).toMatchObject({disposition:n===0?'admitted':'grouped'});
 const [candidate]=await f.db.select().from(savLearningCandidates);expect(candidate.evidenceCaseCount).toBe(4);expect(candidate.evidenceTicketIds).toHaveLength(3);
 expect(await f.db.select().from(savLearningAdmissionReservations)).toHaveLength(1);
});

it('uses one model call for two concurrent attempts at the same proof',async()=>{
 const results=await Promise.all([run(input(90)),run(input(90))]);
 expect(results.filter(r=>r.disposition==='admitted')).toHaveLength(1);expect(results.filter(r=>r.disposition==='duplicate')).toHaveLength(1);
 expect(modelFetch).toHaveBeenCalledTimes(1);expect(await f.db.select().from(savLearningAdmissionReservations)).toHaveLength(1);
});

it('releases the reservation when the exact approved evidence version is activated',async()=>{
 const item=await article();const metadata={intents:['Support fictif'],limovaPaths:[],prerequisites:[],expectedResult:'Résultat fictif',troubleshooting:'Vérifier humainement.'};
 const [version]=await f.db.insert(contentVersions).values({itemId:item.id,version:1,bodyMarkdown:'Documentation synthétique approuvée.',metadata,changeNote:'Fixture',authorEmail:'ugo@limova.ai'}).returning();
 await f.db.update(contentItems).set({status:'published',publishedVersionId:version.id,currentDraftVersionId:version.id}).where(eq(contentItems.id,item.id));
 await f.db.insert(contentChunks).values({itemId:item.id,versionId:version.id,ordinal:0,content:version.bodyMarkdown,embedding:Array(768).fill(0)});
 state.inventory=[{ref:`content:${item.id}`,versionId:version.id,title:item.title,body:version.bodyMarkdown}];state.match=`content:${item.id}`;
 const admitted=await run(input(91));const candidateId=String((admitted as {candidateId:string}).candidateId);
 await f.db.update(savLearningCandidates).set({status:'approved'}).where(eq(savLearningCandidates.id,candidateId));
 const [candidate]=await f.db.select().from(savLearningCandidates).where(eq(savLearningCandidates.id,candidateId));
 await f.db.insert(savResolutionEvidence).values({itemId:item.id,versionId:version.id,sourceRef:candidate.sourceRef,outcome:'human_resolution'});
 await activateSavKnowledgeVersion({itemId:item.id,expectedPublishedVersionId:version.id,expectedActiveVersionId:null},'ugo@limova.ai');
 expect((await f.db.select().from(savLearningAdmissionReservations))[0].state).toBe('closed');
});

function snapshotFeed(feed:{closed:boolean;updatedAt:string;text:string}) {
 return async(url:unknown,init?:RequestInit)=>{
  const u=String(url);if(u.startsWith('https://generativelanguage.googleapis.com/'))return modelFetch(url,init);
  if(u.startsWith('https://api.hubapi.com/crm/v3/objects/tickets?'))return new Response(JSON.stringify({results:[{id:'99992',createdAt:'2026-10-01T12:00:00Z',updatedAt:feed.updatedAt,properties:{subject:'Cycle fictif',hs_pipeline_stage:feed.closed?'closed':'open',content:'Contenu fictif'},associations:{emails:{results:[{id:'new-human-email'}]}}}]}));
  if(u==='https://api.hubapi.com/crm/v3/objects/emails/batch/read')return Response.json({results:[{id:'new-human-email',properties:{hs_email_text:feed.text,hs_timestamp:'2026-10-15T11:00:00Z',hs_email_direction:'OUTGOING_EMAIL'}}]});
  if(u==='https://api.hubapi.com/crm/v3/pipelines/tickets')return new Response(JSON.stringify({results:[{stages:[{id:'closed',metadata:{ticketState:'CLOSED'}}]}]}));
  throw new Error('UNEXPECTED_MOCK_URL');
 };
}
it('admits an old ticket only after an observed reopening and fresh human evidence',async()=>{
 await f.db.insert(savTicketSnapshots).values({hubspotTicketId:'99992',status:'closed',subject:'Ancien dossier fictif',transcriptCiphertext:encryptSavPayload({transcript:[]}),contentHash:'old',humanIntervened:true,hubspotUpdatedAt:new Date('2026-10-13T12:00:00Z')});
 // PostgreSQL timestamps retain microseconds, unlike JavaScript Date. The CAS must preserve them.
 await f.client.exec("UPDATE sav.ticket_snapshots SET updated_at='2026-10-15T09:00:00.123456Z' WHERE hubspot_ticket_id='99992'");
 const feed={closed:false,updatedAt:'2026-10-15T10:00:00Z',text:resolution};vi.stubGlobal('fetch',snapshotFeed(feed));
 await backfillHubspotTickets({maxPages:1});
 expect((await f.db.select().from(savTicketSnapshots))[0].learningCycleStartedAt?.toISOString()).toBe('2026-10-15T10:00:00.000Z');
 feed.closed=true;feed.updatedAt='2026-10-15T12:00:00Z';await backfillHubspotTickets({maxPages:1});
 expect(await f.db.select().from(savLearningCandidates)).toHaveLength(1);expect(modelFetch).toHaveBeenCalledTimes(1);
 await backfillHubspotTickets({maxPages:1});expect(await f.db.select().from(savLearningCandidates)).toHaveLength(1);expect(modelFetch).toHaveBeenCalledTimes(1);
});
it('blocks a truncated CRM source before model admission',async()=>{
 await f.db.insert(savTicketSnapshots).values({hubspotTicketId:'99992',status:'open',subject:'Dossier fictif',transcriptCiphertext:encryptSavPayload({transcript:[]}),contentHash:'old',humanIntervened:true,learningCycleStartedAt:new Date('2026-10-15T10:00:00Z'),hubspotUpdatedAt:new Date('2026-10-15T10:00:00Z')});
 vi.stubGlobal('fetch',snapshotFeed({closed:true,updatedAt:'2026-10-15T12:00:00Z',text:resolution+'x'.repeat(9000)}));await backfillHubspotTickets({maxPages:1});
 expect(await f.db.select().from(savLearningCandidates)).toHaveLength(0);expect(modelFetch).not.toHaveBeenCalled();
 expect((await f.db.select().from(savLearningAdmissionSignals))[0].reasonCode).toBe('source_truncated');
});


it.each(['reopened','hash','cycle','missing'] as const)('F1 blocks CRM evidence changed during comparison: %s',async kind=>{
 const i=input(110);
 state.beforeResponse=async()=>{
  const where=eq(savTicketSnapshots.hubspotTicketId,i.ticketId);
  if(kind==='missing')await f.db.delete(savTicketSnapshots).where(where);
  else await f.db.update(savTicketSnapshots).set(kind==='reopened'?{status:'open'}:kind==='hash'?{contentHash:'new-source-hash'}:{learningCycleStartedAt:new Date('2026-10-15T11:00:00Z')}).where(where);
 };
 expect(await run(i)).toMatchObject({disposition:'signal',reasonCode:'source_changed'});
 expect(await f.db.select().from(savLearningCandidates)).toHaveLength(0);
 expect(await f.db.select().from(savLearningAdmissionReservations)).toHaveLength(0);
});
it('F1 binds the source proof and blocks both human review entry points after reopening',async()=>{
 const i=input(111);const admitted=await run(i);expect(admitted).toMatchObject({disposition:'admitted'});
 const id=String((admitted as {candidateId:string}).candidateId);
 const {readSavLearningEvidence}=await import('@/lib/knowledge/proposals');
 await expect(readSavLearningEvidence(id,f.db)).resolves.toMatchObject({candidate:{id}});
 const [candidate]=await f.db.select().from(savLearningCandidates).where(eq(savLearningCandidates.id,id));
 expect(decryptSavPayload(candidate.proposedPatch.ciphertext as string)).toMatchObject({sourceSnapshotHash:i.snapshotHash,sourceCycleStartedAt:new Date(i.cycleStartedAt).toISOString()});
 await f.db.update(savTicketSnapshots).set({status:'open'}).where(eq(savTicketSnapshots.hubspotTicketId,i.ticketId));
 await expect(approveLearningCandidate(id,'ugo@limova.ai')).rejects.toThrow('SAV_OBSERVATION_STALE');
 await expect(readSavLearningEvidence(id,f.db)).rejects.toThrow('SAV_OBSERVATION_STALE');
 expect((await f.db.select().from(savLearningCandidates).where(eq(savLearningCandidates.id,id)))[0].status).toBe('pending');
});


it('F2 resumes after final transaction abort and admits exactly once across concurrent retries',async()=>{
 const i=input(120);
 state.beforeResponse=async()=>{vi.spyOn(f.db,'transaction').mockRejectedValueOnce(new Error('SYNTHETIC_FINAL_ABORT'));};
 await expect(run(i)).rejects.toThrow('SYNTHETIC_FINAL_ABORT');
 const [attempt]=await f.db.select().from(savLearningAdmissionAttempts);
 expect(attempt).toMatchObject({state:'retryable',completedAt:null,comparisonLeaseToken:null,comparisonLeaseUntil:null});
 expect(await f.db.select().from(savLearningCandidates)).toHaveLength(0);
 expect(await f.db.select().from(savLearningAdmissionReservations)).toHaveLength(0);
 vi.restoreAllMocks();state.beforeResponse=null;
 const results=await Promise.all([run(i),run(i)]);
 expect(results.filter(r=>r.disposition==='admitted')).toHaveLength(1);
 expect(results.filter(r=>r.disposition==='duplicate')).toHaveLength(1);
 expect(await f.db.select().from(savLearningCandidates)).toHaveLength(1);
 expect(await f.db.select().from(savLearningAdmissionReservations)).toHaveLength(1);
 expect(modelFetch).toHaveBeenCalledTimes(2);
});
it('F2 reclaims a crashed worker only after expiry and fences its late completion',async()=>{
 const i=input(121);
 const sourceHash=savLearningProofHash({sourceRef:i.sourceRef,cycleStartedAt:i.cycleStartedAt,evidenceRef:'hubspot-message:'+i.sourceMessageId,sourceMessageId:i.sourceMessageId,resolution:i.resolution,customerConfirmed:i.customerConfirmed});
 const first=await f.db.transaction(tx=>claimSavLearningComparisonTx(tx,{sourceRef:i.sourceRef,sourceHash,origin:'hubspot',inputHash:'synthetic-input',now}));
 if(!first.claimed)throw new Error('EXPECTED_SYNTHETIC_CLAIM');
 expect(await run(i,new Date(now.getTime()+SAV_LEARNING_COMPARISON_LEASE_MS-1))).toMatchObject({disposition:'duplicate'});
 expect(modelFetch).not.toHaveBeenCalled();
 const later=new Date(now.getTime()+SAV_LEARNING_COMPARISON_LEASE_MS+1);
 state.beforeResponse=async()=>{
  await expect(f.db.transaction(tx=>finishSavLearningComparisonTx(tx,first.signalId,{reasonCode:'late-worker',state:'signal'},later,first.leaseToken))).rejects.toThrow('SAV_LEARNING_SIGNAL_STALE');
 };
 expect(await run(i,later)).toMatchObject({disposition:'admitted'});
 expect(await f.db.select().from(savLearningCandidates)).toHaveLength(1);
 expect(await f.db.select().from(savLearningAdmissionReservations)).toHaveLength(1);
 expect(modelFetch).toHaveBeenCalledTimes(1);
});
