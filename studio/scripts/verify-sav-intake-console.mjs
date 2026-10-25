/** Synthetic UI qualification only. No Clerk tenant, provider, DB or HTTP server.
 * SSR artifacts come from console-ui.test; real browser action is explicitly
 * replaced in this bundle. The server command has separate DB integration tests. */
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const output=process.env.SAV_INTAKE_UI_ARTIFACT_DIR;
if(!output||!path.isAbsolute(output))throw Error("Explicit private artifact directory required");
const temporary=await mkdtemp(path.join(tmpdir(),"sav87-console-browser-"));
let browser;
try {
  const list=await readFile(path.join(output,"console-synthetic.html"),"utf8"),detail=await readFile(path.join(output,"detail-synthetic.html"),"utf8");
  const globals=await readFile(path.join(root,"src/app/globals.css"),"utf8");
  const expected={commandKey:"10000000-0000-4000-8000-000000000010",threadId:"10000000-0000-4000-8000-000000000001",messageId:"10000000-0000-4000-8000-000000000002",runId:"10000000-0000-4000-8000-000000000003",version:7,sourceHash:"a".repeat(64),candidatesHash:"b".repeat(64)};
  const entry=`import React from 'react';import{createRoot}from'react-dom/client';import{IntakeChoiceForm}from${JSON.stringify(path.join(root,"src/app/studio/sav/intake/choice-form.tsx"))};import{MailConversation}from${JSON.stringify(path.join(root,"src/app/studio/sav/[id]/mail-conversation.tsx"))};
  const message={id:${JSON.stringify(expected.messageId)},direction:'inbound',fromEmail:'fiction@example.invalid',receivedAt:new Date('2026-10-21T10:00:00Z'),createdAt:new Date('2026-10-21T10:00:00Z'),body:{text:'My synthetic original request. The connection does not work.',attachments:[]},translation:{status:'complete',language:'en',text:'Ma demande synthétique traduite. La connexion ne fonctionne pas.',revision:'synthetic',sourceHash:'synthetic',errorCode:null}};
  createRoot(document.getElementById('synthetic-root')).render(React.createElement(React.Fragment,null,React.createElement(MailConversation,{messages:[message]}),React.createElement(IntakeChoiceForm,{expected:${JSON.stringify(expected)},contacts:['101','102'],tickets:[],classification:'support'})));`;
  const compiled=await build({stdin:{contents:entry,resolveDir:root,loader:"js"},bundle:true,write:false,format:"iife",platform:"browser",outfile:path.join(temporary,"fixture.js"),nodePaths:[path.join(root,"node_modules")],alias:{"@":path.join(root,"src")},loader:{".css":"local-css"},define:{"process.env.NODE_ENV":JSON.stringify("production")},plugins:[{name:"synthetic-action-only",setup(b){b.onResolve({filter:/^\.\/orientation-actions$/},args=>args.importer.endsWith("choice-form.tsx")?{path:"synthetic-action",namespace:"synthetic"}:null);b.onLoad({filter:/.*/,namespace:"synthetic"},()=>({contents:`export async function submitUxOrientation(previous,form){window.__syntheticCommands??=[];window.__syntheticCommands.push(Object.fromEntries(form));await new Promise(resolve=>setTimeout(resolve,400));if(String(form.get('reason')).includes('conflit'))return{status:'rejected',message:'Le dossier a changé ou un choix existe déjà. Rechargez sa dernière version avant de corriger.'};if(String(form.get('reason')).includes('erreur'))return{status:'rejected',message:'Le choix n’a pas été enregistré. Vérifiez votre accès, le motif et la version courante.'};return{status:'recorded',eventId:'10000000-0000-4000-8000-000000000099',message:'Choix enregistré. Le worker doit revalider les preuves avant toute reprise.'};}export async function lookupUxOrientation(){return{readable:true,receipt:null}}`,loader:"js"}));}}]});
  const script=compiled.outputFiles.find(f=>f.path.endsWith(".js"))?.text,css=compiled.outputFiles.find(f=>f.path.endsWith(".css"))?.text??"";
  assert.ok(script);
  browser=await chromium.launch({headless:true,...(process.env.STUDIO_E2E_CHROMIUM_PATH?{executablePath:process.env.STUDIO_E2E_CHROMIUM_PATH}:{})});
  const checks=[],external=[];
  for(const [name,viewport]of[["desktop",{width:1360,height:900}],["mobile",{width:390,height:844}]]){
    const context=await browser.newContext({viewport});
    await context.route("**/*",async route=>{const url=new URL(route.request().url());if(url.origin!=="https://sav-intake.invalid"){external.push(url.origin);return route.abort();}return route.fulfill({status:200,contentType:"text/html",body:(url.pathname.endsWith(expected.threadId)?detail:list).replace("</style>",":root{--font-body:Arial;--font-mono:monospace}body{font-family:Arial,sans-serif}</style>")});});
    const page=await context.newPage(),errors=[];page.on("pageerror",error=>errors.push(error.message));
    await page.goto("https://sav-intake.invalid/studio/sav/intake");
    assert.equal(await page.locator('nav[aria-label="Vues des nouveaux dossiers"] a').count(),6);
    assert.ok(await page.getByText("En cours et attentes techniques").isVisible());
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:path.join(output,`${name}-console.png`),fullPage:true});
    await page.locator(`a[href^="/studio/sav/intake/${expected.threadId}?"]`).click();
    await page.getByRole("heading",{name:"Actions réellement accomplies"}).waitFor();
    assert.ok(await page.getByText("Résultat incertain, rapprochement requis").isVisible());
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:path.join(output,`${name}-detail.png`),fullPage:true});
    await page.setContent(`<!doctype html><html lang="fr"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${globals}\n${css}\n:root{--font-body:Arial;--font-mono:monospace}body{font-family:Arial,sans-serif;max-width:960px;margin:auto;padding:24px}#synthetic-root{display:grid;gap:24px}</style><h1>Qualification synthétique du formulaire</h1><div id="synthetic-root"></div></html>`);
    await page.addScriptTag({content:script});
    await page.getByText("Ma demande synthétique traduite.",{exact:false}).waitFor();
    await page.getByRole("button",{name:"Voir l’original"}).click();assert.ok(await page.getByText("My synthetic original request.",{exact:false}).isVisible());
    await page.getByRole("button",{name:"Voir la traduction"}).click();
    await page.locator('select[name="contactId"]').selectOption('102');
    await page.getByLabel("Motif de la décision").fill("Preuves synthétiques vérifiées pour le bon compte.");
    await page.getByRole("button",{name:"Enregistrer l’orientation"}).click();
    await page.getByText("Enregistrement de cette décision en cours…").waitFor();
    assert.ok(await page.getByRole("button",{name:"Enregistrer l’orientation"}).isDisabled());
    await page.getByText("Choix enregistré. Le worker doit revalider les preuves avant toute reprise.").waitFor();
    const commands=await page.evaluate(()=>window.__syntheticCommands);assert.equal(commands.length,1);assert.equal(commands[0].contactId,"102");assert.equal(commands[0].sourceHash,expected.sourceHash);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:path.join(output,`${name}-choice-recorded.png`),fullPage:true});
    for(const scenario of ["conflit","erreur"]){
      await page.evaluate(()=>sessionStorage.clear());
      await page.setContent(`<!doctype html><html lang="fr"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${globals}\n${css}\n:root{--font-body:Arial;--font-mono:monospace}body{font-family:Arial,sans-serif;max-width:960px;margin:auto;padding:24px}#synthetic-root{display:grid;gap:24px}</style><h1>Qualification synthétique du formulaire</h1><div id="synthetic-root"></div></html>`);
      await page.addScriptTag({content:script});
      await page.locator('select[name="contactId"]').selectOption('101');
      await page.getByLabel("Motif de la décision").fill(`Preuve synthétique pour scénario ${scenario}.`);
      await page.getByRole("button",{name:"Enregistrer l’orientation"}).click();
      await page.getByRole("alert").waitFor();
      assert.ok(await page.getByRole("button",{name:"Enregistrer l’orientation"}).isEnabled());
      assert.equal(await page.getByLabel("Motif de la décision").inputValue(),`Preuve synthétique pour scénario ${scenario}.`);
      await page.screenshot({path:path.join(output,`${name}-choice-${scenario}.png`),fullPage:true});
    }
    assert.deepEqual(errors,[]);checks.push({viewport:name,sixViews:true,partialHonest:true,originalTranslationToggle:true,conditionalChoice:true,conflictAndErrorVisible:true,noHorizontalOverflow:true,commands:commands.length});
    await context.close();
  }
  assert.deepEqual(external,[]);
  await writeFile(path.join(output,"browser-proof.json"),JSON.stringify({status:"pass",origin:"synthetic SSR + actual client components with explicit fake action",clerkEndToEnd:false,serverCommand:"separate console.test.ts DB/Clerk-mock integration",externalRequests:external,checks},null,2));
  console.log(JSON.stringify({status:"pass",checks,clerkEndToEnd:false,externalRequests:external.length}));
}finally{await browser?.close();await rm(temporary,{recursive:true,force:true});}
