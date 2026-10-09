import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("@/lib/sav/auth",()=>({requireSavStaff:async()=>({email:"ugo@limova.ai"})}));
vi.mock("@/lib/sav/hubspot",()=>({getHubspotBackfillState:async()=>null,HUBSPOT_EMAIL_READ_SCOPE:"fixture",isHubspotEmailReadScopeError:()=>false}));
vi.mock("@/lib/sav/learning",()=>({listLearningCandidates:async()=>[{id:"fixture",status:"pending",syncInProgress:true,proposedSubject:"Résolution fictive",proposedResolution:"Procédure fictive",explanation:"Preuves en cours de lecture",createdAt:new Date(),hubspotTicketId:"123"}]}));
vi.mock("../actions",()=>({continueBackfillAction:()=>{},reviewLearningAction:()=>{}}));
import Page from "./page";
describe("Resolution approval during refresh",()=>{
 it("disables approval and displays a synchronization notice",async()=>{
  const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({review:"sync_in_progress"})}));
  expect(html).toMatch(/value="approve"[^>]*disabled=""/);expect(html).toContain("Les preuves sont en cours d’actualisation");
 });
 it("explains a stale source without a technical exception",async()=>{
  const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({review:"stale"})}));expect(html).toContain("Les preuves ou la qualification ont changé");
 });
});
