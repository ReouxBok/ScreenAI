import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("@/lib/sav/auth",()=>({requireSavStaff:async()=>({email:"ugo@limova.ai"})}));
vi.mock("@/lib/sav/hubspot",()=>({getHubspotBackfillState:async()=>null,HUBSPOT_EMAIL_READ_SCOPE:"fixture",isHubspotEmailReadScopeError:()=>false}));
vi.mock("@/lib/sav/learning",()=>({listLearningCandidates:async()=>[{id:"fixture",status:"pending",syncInProgress:true,proposedSubject:"Résolution fictive",proposedResolution:"Procédure fictive",explanation:"Preuves en cours de lecture",createdAt:new Date(),hubspotTicketId:"123",evidenceCaseCount:2,evidenceTicketIds:["123","456"]}]}));
vi.mock("@/lib/sav/learning-admission",()=>({savLearningAdmissionMetrics:async()=>({cutover:null,dailyModelCalls:0,dailyModelLimit:null,openAutomaticProposals:0,openLimit:10,weeklyLimit:5,signals:[],recentSignals:[]})}));
vi.mock("../actions",()=>({continueBackfillAction:()=>{},reviewLearningAction:()=>{}}));
vi.mock("@/lib/sav/learning-metrics",()=>({savCaseLearningMetrics:async()=>({total:0,late:0,incomplete:0,stages:[],translations:[],budgets:{comparison:20,translation:50,total:60},cohorts:[],sampledComparisons:0,comparisonCount:0,truncated:false})}));
import Page from "./page";
describe("Resolution approval during refresh",()=>{
 it("disables approval and displays a synchronization notice",async()=>{
  const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({review:"sync_in_progress"})}));
  expect(html).toMatch(/value="approve"[^>]*disabled=""/);expect(html).toContain("Les preuves sont en cours d’actualisation");
 });
 it("explains a stale source without a technical exception",async()=>{
  const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({review:"stale"})}));expect(html).toContain("Les preuves ou la qualification ont changé");
 });
 it("keeps the historical intake closed and exposes the bounded learning policy",async()=>{
  const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({})}));
  expect(html).toContain("Activation explicite requise");expect(html).toContain("Aucun ticket historique ne sera retraité");
  expect(html).toContain("plafond non disponible et déduplication");expect(html).toContain("5 nouvelles propositions / 7 jours glissants");expect(html).not.toContain("Analyser 25 maintenant");
 });
});

it("retains representative evidence links without raw identifier labels after composition",async()=>{
 const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({})}));
 expect(html).toContain("Preuve 1");expect(html).toContain("Preuve 2");
 expect(html).toContain("/ticket/123");expect(html).toContain("/ticket/456");
 expect(html).not.toContain("#123");expect(html).not.toContain("#456");
});
