/** Actual UX components; synthetic identity/actions/HTTP only. Never contact a provider. */
import { build } from "esbuild";
import { chromium } from "playwright";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = process.env.SAV_UX_ARTIFACT_DIR;
if (!output || !path.isAbsolute(output)) throw Error("Explicit artifact directory required");
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(tmpdir(), "sav-ux-browser-"));
const id = "10000000-0000-4000-8000-000000000001";
const expected = { commandKey: "10000000-0000-4000-8000-000000000010", threadId: id, messageId: "10000000-0000-4000-8000-000000000002", runId: "10000000-0000-4000-8000-000000000003", version: 7, sourceHash: "a".repeat(64), candidatesHash: "b".repeat(64) };
const formPath = path.join(root, "src/app/studio/sav/intake/choice-form.tsx");
const navPath = path.join(root, "src/app/studio/sav/intake/navigation.tsx");
const linkStub = "import React from 'react';export default function Link({href,children,prefetch,scroll,replace,...props}){return React.createElement('a',{...props,href},children)}";
const fakeActions = `export async function submitUxOrientation(previous,form){
 const command=Object.fromEntries(form);window.__uxCalls??=[];window.__uxCalls.push(command);
 await new Promise(resolve=>setTimeout(resolve,180));
 if(command.reason.includes('rejet'))return{status:'rejected',message:'Les sources ont changé. La saisie reste conservée.'};
 sessionStorage.setItem('ux-fixture-receipt:'+command.commandKey,JSON.stringify({eventId:'10000000-0000-4000-8000-000000000099',state:'pending',parentVersion:7,at:'2026-10-25T18:00:00Z'}));
 if(command.reason.includes('incertain'))throw Error('synthetic lost response');
 return{status:'recorded',eventId:'10000000-0000-4000-8000-000000000099',message:'Décision enregistrée, revalidation en attente.'};}
 export async function lookupUxOrientation(input){return{readable:true,receipt:JSON.parse(sessionStorage.getItem('ux-fixture-receipt:'+input.commandKey)||'null')}}`;
const entry = `import React from 'react';import{createRoot}from'react-dom/client';
 import{IntakeChoiceForm}from${JSON.stringify(formPath)};
 import{IntakeBackLink,IntakeDossierLink,IntakeListPosition}from${JSON.stringify(navPath)};
 import{intakeDossierHref}from${JSON.stringify(path.join(root,"src/lib/sav/intake-ux/navigation.ts"))};
 import{IntakeCrmContext}from${JSON.stringify(path.join(root,"src/app/studio/sav/intake/crm-context.tsx"))};
 import{StudioShell}from${JSON.stringify(path.join(root,"src/components/studio-shell.tsx"))};
 import styles from${JSON.stringify(path.join(root,"src/app/studio/sav/intake/intake.module.css"))};
 const expected=${JSON.stringify(expected)},origin=location.pathname+location.search;
 const display={contacts:{101:{label:'Camille Exemple — compte principal',url:'https://app.hubspot.com/contacts/123/record/0-1/101',available:true},102:{label:'Camille Exemple — compte lié',url:'https://app.hubspot.com/contacts/123/record/0-1/102',available:true}},tickets:{201:{label:'Connexion à la plateforme',url:'https://app.hubspot.com/contacts/123/record/0-5/201',available:true},202:{label:'Facturation — retour client',url:'https://app.hubspot.com/contacts/123/record/0-5/202',available:true}}};
 const content=location.pathname.endsWith(expected.threadId)?React.createElement('div',{className:styles.console},
 React.createElement(IntakeBackLink,{returnTo:new URLSearchParams(location.search).get('returnTo'),className:styles.back}),
 React.createElement('h1',null,'Choisir l’orientation de cette demande'),
 React.createElement(IntakeCrmContext,{contact:display.contacts[101],ticket:display.tickets[201],confirmed:false,creationPlanned:false}),
 React.createElement(IntakeChoiceForm,{expected,actorId:'synthetic-staff',contacts:['101','102'],tickets:['201','202'],classification:'support',selectedTicketId:'201',display})):
 React.createElement('div',{className:styles.console},React.createElement(IntakeListPosition,{origin}),React.createElement('h1',null,'À valider — liste de qualification'),
 React.createElement('p',null,'Page 2 · recherche connexion · tri récent'),
 ...Array.from({length:35},(_,i)=>{const rowId=i===14?expected.threadId:'10000000-0000-4000-8000-'+String(i+100).padStart(12,'0');return React.createElement(IntakeDossierLink,{key:i,id:rowId,origin,href:intakeDossierHref(rowId,origin),className:styles.row},React.createElement('strong',null,'Demande de connexion · exemple '+(i+1)),React.createElement('span',null,'Choisir le compte et le ticket'))}));
 createRoot(document.getElementById('ux-root')).render(React.createElement(StudioShell,{staff:{id:'synthetic-staff',email:'ugo@limova.ai',name:'Responsable SAV',role:'admin'}},content));`;
let browser;
try {
  const bundle = await build({ stdin: { contents: entry, resolveDir: root, loader: "js" }, bundle: true, write: false, format: "iife", platform: "browser", outfile: path.join(temporary,"ux.js"),
    nodePaths: [path.join(root,"node_modules")], alias: { "@": path.join(root,"src") }, loader: { ".css": "local-css" },
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env.DEV_AUTH_BYPASS": JSON.stringify("false") },
    plugins: [{ name: "synthetic-boundary", setup(b) {
      b.onResolve({filter:/^\.\/orientation-actions$/},args=>args.importer===formPath?{path:"actions",namespace:"ux"}:null);
      b.onResolve({filter:/^next\/link$/},()=>({path:"link",namespace:"ux"}));
      b.onResolve({filter:/^@clerk\/nextjs$/},()=>({path:"identity",namespace:"ux"}));
      b.onLoad({filter:/.*/,namespace:"ux"},args=>({contents:args.path==="actions"?fakeActions:args.path==="link"?linkStub:"export function UserButton(){return null}",loader:"js",resolveDir:root}));
    } }] });
  const js=bundle.outputFiles.find(f=>f.path.endsWith(".js")).text,css=bundle.outputFiles.find(f=>f.path.endsWith(".css"))?.text??"";
  const globals=await readFile(path.join(root,"src/app/globals.css"),"utf8");
  const html=`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Qualification locale UX SAV</title><style>${globals}\n${css}\n:root{--font-body:Arial;--font-display:Georgia;--font-mono:monospace}body{margin:0}button{min-height:44px}</style></head><body><div id="ux-root"></div><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`;
  await writeFile(path.join(output,"preview.html"),html);
  browser=await chromium.launch({headless:true,...(process.env.STUDIO_E2E_CHROMIUM_PATH?{executablePath:process.env.STUDIO_E2E_CHROMIUM_PATH}:{})});
  const checks=[],external=[];
  for(const [name,viewport] of [["desktop",{width:1360,height:900}],["mobile",{width:390,height:844}],["compact",{width:320,height:740}],["zoom200",{width:680,height:450}]]) {
    const context=await browser.newContext({viewport,...(name==="zoom200"?{deviceScaleFactor:2}:{})});
    await context.route("**/*",route=>{const u=new URL(route.request().url());if(u.origin!=="https://sav-ux.invalid"){external.push(u.origin);return route.abort();}return route.fulfill({status:200,contentType:"text/html",body:html});});
    const page=await context.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));
    const list="https://sav-ux.invalid/studio/sav/intake?view=to_validate&q=connexion&page=2&sort=newest";
    await page.goto(list);await page.getByRole("heading",{name:"À valider — liste de qualification"}).waitFor();
    const link=page.locator('a[href*="returnTo="]').nth(14);await link.scrollIntoViewIfNeeded();await link.click();
    await page.getByRole("heading",{name:"Modifier l’orientation",exact:true}).waitFor();
    const memory=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('sav:intake:last-list:v1')));assert.ok(memory.y>0);
    assert.ok((await page.getByRole("link",{name:"Retour à la liste SAV",exact:false}).getAttribute("href")).includes("page=2"));
    assert.equal(await page.getByRole("link",{name:"Ouvrir la fiche HubSpot"}).getAttribute("target"),"_blank");
    assert.ok((await page.getByRole("link",{name:"Ouvrir le ticket HubSpot"}).getAttribute("rel")).includes("noopener"));
    await page.getByLabel("Fiche candidate").selectOption("102");await page.getByLabel("Catégorie",{exact:true}).selectOption("finance");await page.getByLabel("Ticket à examiner").selectOption("202");
    await page.getByLabel("Motif de la décision").fill("Preuves synthétiques vérifiées pour la fiche liée et la facturation.");
    await page.reload();assert.equal(await page.getByLabel("Fiche candidate").inputValue(),"102");assert.equal(await page.getByLabel("Catégorie",{exact:true}).inputValue(),"finance");
    await page.getByRole("button",{name:"Enregistrer l’orientation"}).evaluate(button=>{button.click();button.click();});
    await page.getByText("Décision enregistrée, revalidation en attente.").waitFor();
    const commands=await page.evaluate(()=>window.__uxCalls);assert.equal(commands.length,1);assert.equal(commands[0].classification,"finance");assert.equal(commands[0].contactId,"102");assert.equal(commands[0].ticketId,"202");
    await page.reload();assert.ok(await page.getByRole("button",{name:"Enregistrer l’orientation"}).isDisabled());
    await page.getByRole("button",{name:"Vérifier la commande enregistrée"}).click();await page.getByText("Commande retrouvée",{exact:false}).waitFor();
    await page.screenshot({path:path.join(output,`${name}-orientation.png`),fullPage:true});
    await page.getByRole("link",{name:"Retour à la liste SAV",exact:false}).click();await page.getByRole("heading",{name:"À valider — liste de qualification"}).waitFor();
    assert.equal(new URL(page.url()).searchParams.get("page"),"2");assert.equal(new URL(page.url()).searchParams.get("q"),"connexion");
    await page.waitForFunction(y=>Math.abs(scrollY-y)<5,memory.y);await page.goBack();await page.getByRole("heading",{name:"Modifier l’orientation",exact:true}).waitFor();
    await page.evaluate(()=>sessionStorage.clear());await page.reload();
    await page.getByLabel("Motif de la décision").fill("Motif synthétique rejet des sources modifiées.");await page.getByRole("button",{name:"Enregistrer l’orientation"}).click();
    await page.getByRole("alert").waitFor();assert.ok((await page.getByLabel("Motif de la décision").inputValue()).includes("rejet"));
    assert.ok(await page.getByRole("button",{name:"Enregistrer l’orientation"}).isEnabled());
    await page.getByLabel("Motif de la décision").fill("Motif synthétique résultat incertain après enregistrement.");await page.getByRole("button",{name:"Enregistrer l’orientation"}).click();
    await page.getByRole("alert").waitFor();await page.reload();assert.ok(await page.getByRole("button",{name:"Enregistrer l’orientation"}).isDisabled());
    await page.getByRole("button",{name:"Vérifier la commande enregistrée"}).click();await page.getByText("Commande retrouvée",{exact:false}).waitFor();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:path.join(output,`${name}-uncertain.png`),fullPage:true});
    await page.goto(`https://sav-ux.invalid/studio/sav/intake/${id}?returnTo=${encodeURIComponent("https://bad.invalid/")}`);
    const back=await page.getByRole("link",{name:"Retour à la liste SAV",exact:false}).getAttribute("href");assert.ok(back.startsWith("/studio/sav"));assert.ok(!back.includes("bad.invalid"));
    assert.deepEqual(errors,[]);checks.push({viewport:name,singleCombinedSubmit:true,draftAfterRefresh:true,receiptAfterRefresh:true,uncertainFrozenAndReadOnlyLookup:true,listPageSearchSortAndPosition:true,browserBack:true,safeCrmLinks:true,noHorizontalOverflow:true});await context.close();
  }
  assert.deepEqual(external,[]);await writeFile(path.join(output,"ux-browser-proof.json"),JSON.stringify({status:"pass",checks,externalRequests:external,nextRouterIntegration:false,clerkIntegration:false,providers:"synthetic",fonts:"theme variables preserved; local fallback fonts in fixture"},null,2));console.log(JSON.stringify({status:"pass",checks}));
} finally { await browser?.close();await rm(temporary,{recursive:true,force:true}); }
