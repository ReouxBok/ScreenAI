import { createElement, Fragment, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { beforeEach, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({ staff: vi.fn(), list: vi.fn(), detail: vi.fn(), action: vi.fn(), crmDisplay: vi.fn() }));
vi.mock("@/lib/sav/intake/crm-display-server",()=>({readIntakeCrmDisplay:mocks.crmDisplay}));
vi.mock("@/lib/sav/intake/console-auth",()=>({requireIntakeConsoleStaff:mocks.staff}));
vi.mock("@/lib/sav/intake/console-store",()=>({listIntakeConsole:mocks.list}));
vi.mock("@/lib/sav/intake/console-detail",()=>({readIntakeConsoleDetail:mocks.detail}));
vi.mock("./actions",()=>({saveIntakeChoice:mocks.action,requestRecoveryAction:mocks.action,reconcileIdentificationAction:mocks.action,reconcileNoteAction:mocks.action,completeIntakeDossierAction:mocks.action}));
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
  progress:{confirmed:false,state:"uncertain",ticketId:"201",reason:"SAV_INTAKE_EXECUTION_RECONCILIATION_REQUIRED",effects:[{id:"effect-1",kind:"ticket_create",state:"confirmed",confirmedAt:at},{id:"effect-2",kind:"email_associate",state:"uncertain",confirmedAt:null}]},choices:[]};
beforeEach(()=>{vi.clearAllMocks();mocks.crmDisplay.mockResolvedValue({contacts:{"101":{label:"Alice Test",url:"https://app.hubspot.com/contacts/123/record/0-1/101",available:true}},tickets:{"201":{label:"Connexion interrompue",url:"https://app.hubspot.com/contacts/123/record/0-5/201",available:true}}});mocks.staff.mockResolvedValue({id:"synthetic",email:"ugo@limova.ai",role:"admin"});mocks.list.mockResolvedValue(fixture);mocks.detail.mockResolvedValue(detail);});
const renderList=async(query:{view?:string;q?:string;page?:string}={})=>renderToStaticMarkup(createElement(Fragment,null,await IntakeConsolePage({searchParams:Promise.resolve(query)})));
const renderDetail=async()=>renderToStaticMarkup(createElement(Fragment,null,await IntakeDetailPage({params:Promise.resolve({id:threadId})})));
it("offers explicit manual completion on the latest message only for the existing authorized operator, without acting on GET",async()=>{
  const html=await renderDetail();expect(html).toContain("Passer en Terminés");expect(html).toContain("J’ai déjà traité cette demande");
  expect(html).toMatch(/<input(?=[^>]*name="confirmed")(?=[^>]*required="")[^>]*>/);expect(html).toContain(`name="messageId" value="${messageId}"`);expect(mocks.action).not.toHaveBeenCalled();
  mocks.detail.mockResolvedValue({...detail,handledExternally:true});expect(await renderDetail()).not.toContain("Passer en Terminés");
  mocks.detail.mockResolvedValue(detail);mocks.staff.mockResolvedValue({email:"reouven@limova.ai",role:"admin"});expect(await renderDetail()).not.toContain("Passer en Terminés");
  mocks.staff.mockResolvedValue({email:"ugo@limova.ai",role:"member"});expect(await renderDetail()).not.toContain("Passer en Terminés");
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
  const html=await renderDetail();expect(html).toContain("Analyse bloquée");expect(html).toContain("deux tentatives");
  expect(html).toContain("Version 6");expect(html).toContain("qualification de la demande");
  expect(html).not.toContain("Aucun incident enregistré");expect(html).not.toContain('name="sourceHash"');expect(mocks.action).not.toHaveBeenCalled();
});

it("shows named clickable proposed contacts/tickets without turning the proposal into a confirmed result",async()=>{
 mocks.detail.mockResolvedValue({...detail,current:{...detail.current,payload:{...detail.current.payload,plan:{...detail.current.payload.plan,decision:{...detail.current.payload.plan.decision,disposition:{kind:"ticket",target:{operation:"link",contactId:"101",ticketId:"201"}}}}}}});
 const html=await renderDetail();expect(html).toContain("Alice Test");expect(html).toContain("Connexion interrompue");expect(html).toContain('href="https://app.hubspot.com/contacts/123/record/0-1/101"');expect(html).toContain('href="https://app.hubspot.com/contacts/123/record/0-5/201"');expect(html).toContain('rel="noopener noreferrer"');expect(html).not.toContain("Contact HubSpot 101");expect(html).not.toContain("Ticket confirmé :");expect(mocks.action).not.toHaveBeenCalled();
});
