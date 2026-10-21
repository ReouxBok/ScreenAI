/** Synthetic browser proof of the actual administrator client. All server
 * actions are explicit fakes here; their DB/auth primitives are tested separately. */
import { mkdtemp,readFile,writeFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const output=process.env.SAV_INTAKE_UI_ARTIFACT_DIR;
if(!output||!path.isAbsolute(output))throw Error("Private artifact directory required");
const temporary=await mkdtemp(path.join(tmpdir(),"sav87-admin-browser-"));let browser;
try {
  const globals=await readFile(path.join(root,"src/app/globals.css"),"utf8");
  const entry=`import React from 'react';import{createRoot}from'react-dom/client';import{LaunchAdminForm}from${JSON.stringify(path.join(root,"src/app/studio/sav/intake/launch/launch-form.tsx"))};createRoot(document.getElementById('root')).render(React.createElement(LaunchAdminForm,{commandId:'10000000-0000-4000-8000-000000000011'}));`;
  const compiled=await build({stdin:{contents:entry,resolveDir:root,loader:"js"},bundle:true,write:false,format:"iife",platform:"browser",outfile:path.join(temporary,"fixture.js"),nodePaths:[path.join(root,"node_modules")],loader:{".css":"local-css"},define:{"process.env.NODE_ENV":JSON.stringify("production")},plugins:[{name:"fake-admin-actions",setup(b){
    b.onResolve({filter:/^\.\/actions$/},args=>args.importer.endsWith("launch-form.tsx")?{path:"fake-admin",namespace:"synthetic"}:null);
    b.onLoad({filter:/.*/,namespace:"synthetic"},()=>({loader:"js",contents:`
      const pause=()=>new Promise(r=>setTimeout(r,250));const call=(kind,form)=>{window.__adminCalls??=[];window.__adminCalls.push({kind,...Object.fromEntries(form)});};
      export async function previewLaunchAction(previous,form){call('preview',form);await pause();const text=String(form.get('configuration'));if(text.includes('synthetic_failure'))return{ok:false,message:'La commande a été refusée.',code:'SAV_SYNTHETIC_FAILURE'};return{ok:true,message:'Aperçu conservé. Vérifiez le contenu exact avant de confirmer.',submittedJson:text,preview:{id:String(form.get('commandId')),hash:'a'.repeat(64),expiresAt:'2099-01-01T00:00:00Z',input:JSON.parse(text)}};}
      export async function commitLaunchAction(previous,form){call('commit',form);await pause();return{ok:true,message:'Frontière et autorité enregistrées. Les interrupteurs serveur restent inchangés ; OFF conserve les nouveaux mails en attente.',receipt:{policyId:'10000000-0000-4000-8000-000000000012',policyHash:'b'.repeat(64)}};}
      export async function revokeLaunchAction(previous,form){call('revoke',form);await pause();return{ok:true,message:'Autorité révoquée. Aucun nouveau départ sous cette politique ; les rapprochements et reçus tardifs restent conservés.'};}
    `}));
  }}]});
  const js=compiled.outputFiles.find(f=>f.path.endsWith(".js")).text,css=compiled.outputFiles.find(f=>f.path.endsWith(".css"))?.text??"";
  const html=`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${globals}\n${css}\n:root{--font-body:Arial;--font-mono:monospace}body{font-family:Arial,sans-serif;padding:24px;max-width:1040px;margin:auto}</style><h1>Lancement SAV — qualification synthétique</h1><div id="root"></div></html>`;
  browser=await chromium.launch({headless:true,...(process.env.STUDIO_E2E_CHROMIUM_PATH?{executablePath:process.env.STUDIO_E2E_CHROMIUM_PATH}:{})});
  const checks=[],external=[];
  for(const [name,viewport] of [["desktop",{width:1360,height:900}],["mobile",{width:390,height:844}]]) {
    const context=await browser.newContext({viewport}),page=await context.newPage(),errors=[];
    await context.route("**/*",async route=>{if(new URL(route.request().url()).origin!=="https://sav-intake.invalid"){external.push(route.request().url());return route.abort();}return route.fulfill({status:200,contentType:"text/html",body:html});});
    page.on("pageerror",error=>errors.push(error.message));
    await page.goto("https://sav-intake.invalid/studio/sav/intake/launch");await page.addScriptTag({content:js});
    const configuration=page.getByLabel("Configuration JSON privée"),prepare=page.getByRole("button",{name:"Préparer un nouvel aperçu"});
    await configuration.fill('{"runtime":{"synthetic":true},"policy":{"maxDossiers":100}}');await prepare.click();
    await page.getByText("Vérification des paramètres…").waitFor();assert.ok(await prepare.isDisabled());
    const confirm=page.getByRole("button",{name:"Confirmer la frontière et la politique"});await confirm.waitFor();assert.ok(await confirm.isEnabled());
    await configuration.fill('{"runtime":{"synthetic":true},"policy":{"maxDossiers":99}}');assert.ok(await confirm.isDisabled());
    await prepare.click();await page.getByText('"maxDossiers": 99',{exact:false}).waitFor();assert.ok(await confirm.isEnabled());
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,`${name}-admin-preview.png`),fullPage:true});
    await confirm.click();await page.getByText("Enregistrement de la confirmation…").waitFor();
    await page.getByText("Frontière et autorité enregistrées.",{exact:false}).waitFor();assert.ok(await confirm.isDisabled());
    await page.getByLabel("Motif de révocation").fill("Révocation synthétique explicitement vérifiée.");await page.getByRole("button",{name:"Révoquer cette autorité"}).click();
    await page.getByText("Autorité révoquée.",{exact:false}).waitFor();
    const calls=await page.evaluate(()=>window.__adminCalls);assert.equal(calls.filter(c=>c.kind==='commit').length,1);assert.equal(calls.filter(c=>c.kind==='revoke').length,1);assert.equal(calls.find(c=>c.kind==='commit').hash,'a'.repeat(64));
    await page.screenshot({path:path.join(output,`${name}-admin-committed.png`),fullPage:true});
    await page.goto("https://sav-intake.invalid/studio/sav/intake/launch");await page.addScriptTag({content:js});
    await configuration.fill('{"synthetic_failure":true}');await prepare.click();await page.getByRole("alert").waitFor();assert.equal(await configuration.inputValue(),'{"synthetic_failure":true}');assert.equal(await confirm.count(),0);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,`${name}-admin-error.png`),fullPage:true});
    assert.deepEqual(errors,[]);checks.push({viewport:name,twoClicks:true,changedBodyDisablesCommit:true,exactHash:true,pending:true,revocation:true,errorKeepsInput:true,overflow:false});await context.close();
  }
  assert.deepEqual(external,[]);const proof={status:"pass",checks,clerkEndToEnd:false,serverActions:"explicit mocks; real FormData/auth/DB tested separately",externalRequests:0};
  await writeFile(path.join(output,"admin-browser-proof.json"),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
}finally{await browser?.close();await rm(temporary,{recursive:true,force:true});}
