// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { v0Proposal } from "../../../../../test/sav-v0-review-fixture";
vi.mock("../actions", () => ({ saveHumanDraftAction: vi.fn(), reviewDraftAction: vi.fn(), sendSuggestedReplyAction: vi.fn() }));
import { DraftReview } from "./draft-review";
type Props=ComponentProps<typeof DraftReview>;
let host:HTMLDivElement,root:Root;
function props(stale=true):Props {
 const proposal=v0Proposal("Suggestion IA initiale.");
 return {threadId:"thread",messageId:"message",recipient:"synthetic@example.invalid",data:{before:proposal,proposal,decisionId:"decision",agentRunId:"run",model:"fixture",promptRevision:"fixture",expectedReviewId:null,draftHash:"a".repeat(43),confirmationSourceHash:"a".repeat(43),draftVerdict:null,historicalReview:null,review:null},drafts:{knowledgeRevision:"synthetic",versions:[{id:"same-current-draft",revision:1,status:"draft",createdAt:new Date(),createdBy:"ugo@limova.ai",text:"Version humaine historique.",origin:"human",sourceHash:"old",isCurrent:true,stale}]},sendAllowed:true};
}
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);vi.stubGlobal("crypto",webcrypto);host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
const field=()=>host.querySelector<HTMLTextAreaElement>('textarea[name="text"]')!;
const origin=()=>host.querySelector<HTMLInputElement>('input[name="origin"]')!.value;
async function render(p:Props){await act(async()=>{root.render(createElement(DraftReview,p));});}
it.each(["sourceHash","messageId","decisionId","agentRunId"])("resets untouched stale-current editor on %s change without claiming human authorship",async changed=>{
 const before=props();await render(before);expect(field().value).toBe("Suggestion IA initiale.");expect(origin()).toBe("ai");
 const next={...before,data:{...before.data,proposal:{...before.data.proposal,replyDraft:"Nouvelle suggestion IA."}}};
 if(changed==="sourceHash")next.data.confirmationSourceHash="b".repeat(43);else if(changed==="messageId")next.messageId="new-message";else next.data[changed as "decisionId"|"agentRunId"]="new-identity";
 await render(next);expect(field().value).toBe("Nouvelle suggestion IA.");expect(origin()).toBe("ai");expect(host.textContent).toContain("Réponse préparée avec l’aide d’une IA et validée par notre équipe.");expect(host.textContent).toContain("Version humaine historique.");expect(next.drafts.versions[0].id).toBe(before.drafts.versions[0].id);
});
it("replaces an applicable human version with the new AI suggestion when that same current version becomes stale",async()=>{
 const before=props(false);await render(before);expect(field().value).toBe("Version humaine historique.");expect(origin()).toBe("human");
 const next={...before,data:{...before.data,confirmationSourceHash:"b".repeat(43),proposal:{...before.data.proposal,replyDraft:"Nouvelle suggestion IA."}},drafts:{...before.drafts,versions:before.drafts.versions.map(d=>({...d,stale:true}))}};
 await render(next);expect(field().value).toBe("Nouvelle suggestion IA.");expect(origin()).toBe("ai");expect(host.textContent).toContain("Version humaine historique.");
});
