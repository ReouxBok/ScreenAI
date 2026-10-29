import { createElement, Fragment, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prerender } from "react-dom/static";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { beforeEach, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({ staff: vi.fn(), list: vi.fn(), detail: vi.fn(), action: vi.fn(), crmDisplay: vi.fn(), controls: vi.fn(), manualOther:vi.fn(), operator:vi.fn() }));
vi.mock("@/lib/sav/intake/manual-other-classification",()=>({readManualOtherEligibility:mocks.manualOther,manualOtherUnavailableLabels:{inventory_incomplete:"L’inventaire des pièces jointes est incomplet ou non certifié.",paused:"Une pause humaine protège ce dossier.",effects_engaged:"Une action engagée ou son résultat reste à vérifier."}}));
vi.mock("./manual-other-actions",()=>({classifyManualOtherAction:mocks.action}));
vi.mock("@/lib/sav/intake-ux/operator-commands",()=>({readOperatorPanel:mocks.operator}));
vi.mock("@/lib/sav/intake-ux/message-controls",()=>({readUxMessageControls:mocks.controls}));
vi.mock("@/lib/sav/intake/crm-display-server",()=>({readIntakeCrmDisplay:mocks.crmDisplay}));
vi.mock("@/lib/sav/intake/console-auth",()=>({requireIntakeConsoleStaff:mocks.staff}));
vi.mock("@/lib/sav/intake/console-store",()=>({listIntakeConsole:mocks.list}));
// The async pause banner has its own test (agent-pause-ui.test.ts).
vi.mock("./agent-pause-banner",()=>({AgentPauseBanner:()=>null}));
vi.mock("@/lib/sav/intake/console-detail",()=>({readIntakeConsoleDetail:mocks.detail}));
vi.mock("./actions",()=>({saveIntakeChoice:mocks.action,requestRecoveryAction:mocks.action,reconcileIdentificationAction:mocks.action,reconcileNoteAction:mocks.action,completeIntakeDossierAction:mocks.action,releaseIntakeHumanHoldAction:mocks.action}));
vi.mock("next/link",()=>({default:(props:ComponentProps<"a">)=>createElement("a",props)}));
vi.mock("next/navigation",()=>({notFound:()=>{throw Error("NOT_FOUND");}}));
import IntakeConsolePage from "./page";
import IntakeDetailPage from "./[id]/page";
import IntakeConsoleError from "./error";
import styles from "./intake.module.css";
const threadId="10000000-0000-4000-8000-000000000001",messageId="10000000-0000-4000-8000-000000000002",runId="10000000-0000-4000-8000-000000000003";
const at=new Date("2026-10-21T10:00:00Z");
const fixture={installed:true,counts:{learning:1,missing_contact:1,to_validate:2,sensitive:1,completed:1,other:1,processing:3},rows:[{
  threadId,mailboxId:"10000000-0000-4000-8000-000000000004",messageId,version:7,subject:"Connexion interrompue après une modification de configuration — demande synthétique complète et longue",fromEmail:"fiction@example.invalid",receivedAt:at,updatedAt:at,
  view:null,status:"waiting",reason:"SAV_INTAKE_RUNTIME_BUDGET_EXHAUSTED"}],page:1,pages:2,total:26};
const detail={thread:{id:threadId,subject:fixture.rows[0].subject,paused:false,ticketId:null},projection:{epoch:1,projectedEpoch:1,status:"human_choice",reason:null},latestMessageId:messageId,
  current:{id:runId,messageId,candidateContactIds:["101","102"],sourceHash:"a".repeat(64),version:7,sourceMatches:true,payload:{reason:"SAV_INTAKE_RUNTIME_USAGE_UNCERTAIN",plan:{candidateContactIds:["101","102"],decision:{classification:"support",disposition:{kind:"collect_context",reasons:["contact_ambiguous"]},evidence:[{id:"current",source:"current_message",sourceId:messageId,observedAt:at.toISOString()}]}}}},
  messages:[{id:messageId,direction:"inbound",fromEmail:"fiction@example.invalid",receivedAt:at,createdAt:at,body:{text:"My synthetic connection no longer works. Please inspect this complete test request.",attachments:[]},translation:{status:"complete",language:"en",text:"Ma connexion synthétique ne fonctionne plus. Merci de vérifier cette demande de test complète.",revision:"synthetic",sourceHash:"synthetic",errorCode:null}}],historyTruncated:false,
  progress:{runId,confirmed:false,state:"uncertain",ticketId:"201",reason:"SAV_INTAKE_EXECUTION_RECONCILIATION_REQUIRED",effects:[{id:"effect-1",kind:"ticket_create",state:"confirmed",confirmedAt:at},{id:"effect-2",kind:"email_associate",state:"uncertain",confirmedAt:null}]},choices:[]};
beforeEach(()=>{vi.clearAllMocks();mocks.manualOther.mockResolvedValue(null);vi.unstubAllEnvs();mocks.operator.mockResolvedValue({information:null,allowResume:false,allowReanalysis:true,allowInformation:true,unavailableReason:"Synthetic protected state",resume:null});mocks.controls.mockResolvedValue({blocked:false});mocks.crmDisplay.mockResolvedValue({contacts:{"101":{label:"Alice Test",url:"https://app.hubspot.com/contacts/123/record/0-1/101",available:true}},tickets:{"201":{label:"Connexion interrompue",url:"https://app.hubspot.com/contacts/123/record/0-5/201",available:true}}});mocks.staff.mockResolvedValue({id:"synthetic",email:"ugo@limova.ai",role:"admin"});mocks.list.mockResolvedValue(fixture);mocks.detail.mockResolvedValue(detail);});
const renderList=async(query:{view?:string;q?:string;page?:string;sort?:string}={})=>renderToStaticMarkup(createElement(Fragment,null,await IntakeConsolePage({searchParams:Promise.resolve(query)})));
// The detail page streams HubSpot names under Suspense: wait for every boundary,
// as the browser does once the stream ends. The shell alone is the first flush.
const detailElement=async()=>createElement(Fragment,null,await IntakeDetailPage({params:Promise.resolve({id:threadId})}));
// Hydration-only text separators and boundary markers are dropped, as static markup does.
const renderDetail=async()=>{const {prelude}=await prerender(await detailElement());
  return (await new Response(prelude).text()).replace(/<!--(?: |\$|\/\$)-->/g,"");};
const renderDetailShell=async()=>renderToStaticMarkup(await detailElement());
it("offers explicit manual completion on the latest message only for the existing authorized operator, without acting on GET",async()=>{
  const html=await renderDetail();expect(html).toContain("Marquer traité hors Studio");expect(html).toContain("J’ai déjà traité cette demande");
  expect(html).toMatch(/<input(?=[^>]*name="confirmed")(?=[^>]*required="")[^>]*>/);expect(html).toContain(`name="messageId" value="${messageId}"`);expect(mocks.action).not.toHaveBeenCalled();
  mocks.detail.mockResolvedValue({...detail,handledExternally:true});expect(await renderDetail()).not.toContain("Marquer traité hors Studio");
  mocks.detail.mockResolvedValue(detail);mocks.staff.mockResolvedValue({email:"reouven@limova.ai",role:"admin"});expect(await renderDetail()).not.toContain("Marquer traité hors Studio");
  mocks.staff.mockResolvedValue({email:"ugo@limova.ai",role:"member"});expect(await renderDetail()).not.toContain("Marquer traité hors Studio");
});
it("six business views and distinct technical area use supplied counts and French states, without actions on GET",async()=>{
  const html=await renderList();for(const label of ["Traités — en apprentissage","Pas de fiche HubSpot","À valider","Résiliation / Facturation","Terminés","Autres","En cours et attentes techniques","Plafond de qualification atteint"] )expect(html).toContain(label);
  expect(html).not.toContain("SAV_INTAKE_RUNTIME_BUDGET_EXHAUSTED");expect(mocks.action).not.toHaveBeenCalled();
  expect(mocks.list).toHaveBeenCalledWith({view:"processing",mailboxId:undefined,search:undefined,page:1});
});
it("server search and pagination preserve the exact cohort",async()=>{
  const html=await renderList({view:"to_validate",q:"connexion",page:"2"});expect(mocks.list).toHaveBeenCalledWith({view:"to_validate",mailboxId:undefined,search:"connexion",page:2});
  expect(html).toContain("view=to_validate&amp;q=connexion");expect(html).toContain('name="q"');
});
it("detail preserves original/recorded translation and shows partial effects without any false reply or treatment success",async()=>{
  const html=await renderDetail();expect(html).toContain("Ce mail a été traduit de");expect(html).toContain("Ma connexion synthétique ne fonctionne plus");
  expect(html).toContain("Résultat vérifié");expect(html).toContain("Résultat incertain");expect(html).toContain("Aucun brouillon de réponse de résolution");
  expect(html).toContain('name="sourceHash"');expect(html).toContain('name="contactId"');expect(html).toContain("conditionnel");expect(html).not.toContain("Envoyer la réponse");expect(html).not.toContain("Ticket confirmé :");
  expect(mocks.action).not.toHaveBeenCalled();
});
it("database preparation absence and failed reads never become a fabricated zero-success cohort",async()=>{
  mocks.list.mockResolvedValue({...fixture,installed:false});expect(await renderList()).toContain("Console non préparée");
  mocks.list.mockRejectedValue(Error("synthetic"));await expect(renderList()).rejects.toThrow("synthetic");
  const html=renderToStaticMarkup(createElement(IntakeConsoleError,{reset:()=>{}}));expect(html).toContain("Aucun compteur ni résultat vide");expect(html).toContain("Réessayer");
});
it("no authenticated staff means no cohort/detail data is read",async()=>{
  mocks.staff.mockRejectedValue(Error("UNAUTHORIZED"));await expect(renderList()).rejects.toThrow("UNAUTHORIZED");expect(mocks.list).not.toHaveBeenCalled();
});
it("exports the actual rendered synthetic pages only when the private qualification path is explicitly supplied",async()=>{
  const directory=process.env.SAV_INTAKE_UI_ARTIFACT_DIR;if(!directory)return;
  await mkdir(directory,{recursive:true});
  let css=await readFile(new URL("./intake.module.css",import.meta.url),"utf8");
  css=css.replace(/\.([A-Za-z][A-Za-z0-9_]*)/g,(match,name:string)=>styles[name]?`.${styles[name]}`:match);
  const globalCss=await readFile(new URL("../../../globals.css",import.meta.url),"utf8");
  const shell=(content:string)=>`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Qualification synthétique SAV</title><style>${globalCss}\n${css}\n:root{--font-body:Arial;--font-mono:monospace}body{font-family:Arial,sans-serif;padding:24px;max-width:1360px;margin:auto}button,a,input,textarea,select{font-family:Arial,sans-serif}</style><body>${content}</body></html>`;
  await writeFile(`${directory}/console-synthetic.html`,shell(await renderList()));await writeFile(`${directory}/detail-synthetic.html`,shell(await renderDetail()));
});
it("a new inbound or edited source cannot present the former plan as the current decision",async()=>{
  for(const changed of [{...detail,latestMessageId:"10000000-0000-4000-8000-000000000099"},{...detail,current:{...detail.current,sourceMatches:false}}]) {
    mocks.detail.mockResolvedValue(changed);const html=await renderDetail();
    expect(html).toContain("Dernière analyse historique — non applicable");
    const currentPanel=html.split("Décision actuelle</h2>")[1].split("</section>")[0];
    expect(currentPanel).toContain("Analyse en cours ou attente technique");expect(currentPanel).not.toContain("Classification");expect(currentPanel).not.toContain("Fiche proposée");
    expect(html).not.toContain('name="sourceHash"');expect(mocks.action).not.toHaveBeenCalled();
  }
});

it("confirmed own deltas render a current verified result, never a new correction form",async()=>{
  mocks.detail.mockResolvedValue({...detail,confirmedCurrent:true,current:{...detail.current,sourceMatches:false},progress:{...detail.progress,confirmed:true}});
  const html=await renderDetail();expect(html).toContain("Résultat confirmé pour cette demande");expect(html).toContain("Actions réellement accomplies");
  expect(html).not.toContain("Dernière analyse historique");expect(html).not.toContain('name="sourceHash"');
});
it("shows exhausted previous attempts on a pending new version without inheriting an applicable plan",async()=>{
  mocks.detail.mockResolvedValue({...detail,current:{...detail.current,state:"pending",sourceMatches:false,payload:{}},progress:null,
    diagnostics:{messageId,totalAttempts:2,attemptsExhausted:true,runs:[{runId:"old",version:6,state:"superseded",attempts:2,
      diagnostic:{readable:true,reason:"SAV_INTAKE_MODEL_CONTEXT_LIMIT",contextReasons:["classification_incomplete"],traces:[]},events:[]}]}});
  const html=await renderDetail();expect(html).toContain("Analyse bloquée");expect(html).toContain("plafond de tentatives");expect(html).toContain("Prise en charge par l’équipe");
  expect(html).toContain("Version 6");expect(html).toContain("qualification de la demande");
  expect(html).not.toContain("Aucun incident enregistré");expect(html).not.toContain('name="sourceHash"');expect(mocks.action).not.toHaveBeenCalled();
});

it("shows named clickable proposed contacts/tickets without turning the proposal into a confirmed result",async()=>{
 mocks.detail.mockResolvedValue({...detail,current:{...detail.current,payload:{...detail.current.payload,plan:{...detail.current.payload.plan,decision:{...detail.current.payload.plan.decision,disposition:{kind:"ticket",target:{operation:"link",contactId:"101",ticketId:"201"}}}}}}});
 const html=await renderDetail();expect(html).toContain("Alice Test");expect(html).toContain("Connexion interrompue");expect(html).toContain('href="https://app.hubspot.com/contacts/123/record/0-1/101"');expect(html).toContain('href="https://app.hubspot.com/contacts/123/record/0-5/201"');expect(html).toContain('rel="noopener noreferrer"');expect(html).not.toContain("Contact HubSpot 101");expect(html).not.toContain("Ticket confirmé :");expect(mocks.action).not.toHaveBeenCalled();
});
it("streams HubSpot names after the dossier without claiming a name, a confirmation or an unavailable record",async()=>{
 mocks.detail.mockResolvedValue({...detail,current:{...detail.current,payload:{...detail.current.payload,plan:{...detail.current.payload.plan,decision:{...detail.current.payload.plan.decision,disposition:{kind:"ticket",target:{operation:"link",contactId:"101",ticketId:"201"}}}}}}});
 mocks.crmDisplay.mockReturnValue(new Promise(()=>{}));vi.stubEnv("HUBSPOT_PORTAL_ID","123");
 const html=await renderDetailShell();
 expect(html).toContain("Décision actuelle");expect(html).toContain("Actions réellement accomplies");expect(html).toContain("Nom HubSpot en cours de lecture");
 expect(html).toContain('href="https://app.hubspot.com/contacts/123/record/0-1/101"');
 expect(html).not.toContain("Alice Test");expect(html).not.toContain("nom indisponible");expect(html).not.toContain("Nom indisponible");expect(html).not.toContain("sujet indisponible");expect(html).not.toContain("Fiche du ticket confirmé");
 expect(html).not.toContain('name="sourceHash"');expect(mocks.controls).toHaveBeenCalledWith(threadId,messageId);expect(mocks.action).not.toHaveBeenCalled();
});
it("does not label a different run's confirmed CRM effects as the current decision",async()=>{
 mocks.detail.mockResolvedValue({...detail,confirmedCurrent:false,progress:{...detail.progress,runId:"10000000-0000-4000-8000-000000000099",confirmed:true}});
 const html=await renderDetail();expect(html).toContain("Actions historiques conservées");expect(html).not.toContain("Fiche du ticket confirmé");expect(html).not.toContain("Ticket confirmé :");
});
it("clearing an empty search actually clears q and keeps the current view",async()=>{
 mocks.list.mockResolvedValue({...fixture,rows:[],total:0,page:1,pages:1});
 const html=await renderList({view:"to_validate",q:"aucun-resultat",page:"2"});
 const href=html.match(/href="([^"]+)"[^>]*>Effacer la recherche/)?.[1].replaceAll("&amp;","&");
 expect(href).toBeTruthy();const url=new URL(href!,"https://studio.invalid");expect(url.searchParams.get("q")).toBe("");expect(url.searchParams.get("view")).toBe("to_validate");
});
it("reads recovery eligibility for the latest message and exposes persisted information separately",async()=>{
 mocks.detail.mockResolvedValue({...detail,choices:[{id:"old-event",kind:"refuse",parentVersion:1,reason:"Old synthetic refusal",actor:"synthetic",at,state:"refused"}],progress:null});
 const html=await renderDetail();expect(mocks.controls).toHaveBeenCalledWith(threadId,messageId);
 expect(mocks.operator).toHaveBeenCalledWith({threadId,messageId,runId,version:7,sourceHash:"a".repeat(64)});
 expect(html).toContain("Aucune étape disponible");expect(html).toContain("Informations pour l’agent");expect(html).toContain("Enregistrer et refaire l’analyse");
 expect(html).not.toContain("Informations pour l’agent enregistrées");
});

it("submits and preserves the actual server sort with search, view and page",async()=>{
 const html=await renderList({view:"to_validate",q:"connexion",page:"2",sort:"oldest"});
 expect(mocks.list).toHaveBeenCalledWith({view:"to_validate",mailboxId:undefined,search:"connexion",page:2,sort:"oldest"});
 expect(html).toContain('name="sort"');expect(html).toContain('value="oldest" selected=""');expect(html).toContain('sort=oldest');
});

it("a zero-check receipt explains the occupied verifier without claiming a successful check",async()=>{
 const command={requestKey:"10000000-0000-4000-8000-000000000041",threadId,messageId,runId,version:7,sourceHash:"a".repeat(64),kind:"resume",reason:"Verify this synthetic existing receipt."};
 mocks.operator.mockResolvedValue({information:null,allowResume:false,allowReanalysis:false,allowInformation:false,unavailableReason:"Protected state",resume:null,requests:{resume:{command,receipt:{id:command.requestKey,step:"verify_only",state:"finished",outcome:"waiting",checked:0,reason:"SAV_INTAKE_OPERATOR_VERIFICATION_BUSY",at:at.toISOString()}}}});
 const html=await renderDetail();expect(html).toContain("Un autre traitement occupe la vérification");expect(html).toContain("Aucun contrôle n’a été effectué");expect(html).not.toContain("Vérification effectuée");expect(html).not.toContain("SAV_INTAKE_OPERATOR_VERIFICATION_BUSY");
});

it("offers explicit manual Other for a bound valid pending message, with no action on GET", async () => {
  const binding={revision:"sav-intake-manual-other.v2",threadId,messageId,runId,version:7,sourceHash:"a".repeat(64),runSourceHash:null,expectedEpoch:1,attachmentCount:0};
  mocks.manualOther.mockResolvedValue({binding,reason:null});
  mocks.detail.mockResolvedValue({...detail,projection:{...detail.projection,view:null,status:"waiting"},progress:null,current:{...detail.current,sourceHash:null}});
  const html=await renderDetail();
  expect(html).toContain("Classement humain dans Autres");expect(html).toContain("Classer dans Autres");
  expect(html).toContain("Motif du classement");expect(html).toContain("sans verdict IA");
  expect(html).toMatch(/<textarea(?=[^>]*name="reason")(?=[^>]*required="")[^>]*>/);
  expect(html).toMatch(/<input(?=[^>]*name="confirmed")(?=[^>]*required="")[^>]*>/);
  expect(html).toContain(`name="messageId" value="${messageId}"`);expect(mocks.action).not.toHaveBeenCalled();
  mocks.staff.mockResolvedValue({email:"ugo@limova.ai",role:"member"});expect(await renderDetail()).not.toContain("Classement humain dans Autres");
});
it("never offers valid-source Other over a human pause, completion or engaged effect", async () => {
  mocks.manualOther.mockResolvedValue({reason:null,binding:{revision:"sav-intake-manual-other.v2",threadId,messageId,runId,version:7,sourceHash:"a".repeat(64),runSourceHash:null,expectedEpoch:1,attachmentCount:0}});
  for(const state of [{...detail,humanHeld:true},{...detail,thread:{...detail.thread,paused:true}},{...detail,handledExternally:true},detail]) {
    mocks.detail.mockResolvedValue(state);expect(await renderDetail()).not.toContain("Classement humain dans Autres");
  }
  expect(mocks.action).not.toHaveBeenCalled();
});
it("offers human inventory review in processing without claiming that AI read the attachments", async()=>{
  mocks.manualOther.mockResolvedValue({reason:null,binding:{revision:"sav-intake-manual-other.v2",threadId,messageId,runId,version:7,sourceHash:"a".repeat(64),runSourceHash:null,expectedEpoch:1,attachmentCount:2}});
  mocks.detail.mockResolvedValue({...detail,projection:{...detail.projection,view:null,status:"waiting"},progress:null});
  const html=await renderDetail();
  expect(html).toContain("Classer dans Autres");expect(html).toContain("2 pièce(s) jointe(s)");
  expect(html).toContain("texte intégral");expect(html).toContain("pièces jointes non analysées");
  expect(html).toContain("ne les déclare pas lues par l’IA");
  expect(html).toContain('name="attachmentCount" value="2"');expect(mocks.action).not.toHaveBeenCalled();
});
it("explains an incomplete inventory instead of silently hiding the direct Other form", async()=>{
  mocks.manualOther.mockResolvedValue({binding:null,reason:"inventory_incomplete"});
  mocks.detail.mockResolvedValue({...detail,progress:null});
  const html=await renderDetail();expect(html).toContain("Classement dans Autres indisponible");
  expect(html).toContain("inventaire des pièces jointes est incomplet ou non certifié");
  expect(html).not.toContain("Classement humain dans Autres");expect(mocks.action).not.toHaveBeenCalled();
});
