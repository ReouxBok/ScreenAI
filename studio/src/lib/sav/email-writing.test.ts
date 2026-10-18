import { describe, expect, it } from "vitest";
import { styleSavEmailCoverage } from "./email-writing";
import { assembleSavReplySections, assertSavReplyConsistency, savUnderstandingSchema } from "./understanding";
import { coverageFixture, understandingFixture } from "../../../test/sav-understanding-fixtures";
import { savTicketTitle, validSavTicketTitle } from "./ticket-title";
import { savSuggestedTicketTitle } from "./human-process";
import { savRollbackCompatibleProposal } from "./proposal-compatibility";
import { savSemanticE2eProposal } from "../../../test/sav-semantic-e2e-fixture";

describe("independent writing skill within assessed coverage", () => {
  it.each(["fr", "en"] as const)("formats a complete %s email before all consistency checks", language => {
    const u = understandingFixture({language}), parts = coverageFixture(u);
    const output = assembleSavReplySections(u, styleSavEmailCoverage(u, parts));
    expect(output.replyDraft).toMatch(language === "en" ? /^Hello,/ : /^Bonjour,/);
    expect(output.replyDraft).toMatch(language === "en" ? /Kind regards,$/ : /Bien à vous,$/);
    expect(() => assertSavReplyConsistency(u, {...output,category:"technical",responseKind:"handoff",citations:[]})).not.toThrow();
    expect(styleSavEmailCoverage(u, output.coverage)).toEqual(output.coverage);
    expect(parts[0].text).not.toMatch(/Bonjour|Hello/);
  });
  it("adds just one greeting and closing for multiple demands and preserves steps verbatim", () => {
    const u = understandingFixture();u.requests.push({...u.requests[0],id:"second"});
    const parts=coverageFixture(u);parts[0].text="Instruction vérifiée à conserver exactement.";
    const result=assembleSavReplySections(u,styleSavEmailCoverage(u,parts));
    expect(result.replyDraft.match(/Bonjour,/g)).toHaveLength(1);expect(result.replyDraft.match(/Bien à vous,/g)).toHaveLength(1);
    expect(result.replyDraft).toContain(parts[0].text);expect(result.coverage.map(p=>p.requestId)).toEqual(u.requests.map(r=>r.id));
    expect(()=>assertSavReplyConsistency(u,{...result,replyDraft:result.replyDraft+"\nPromesse ajoutée",category:"technical",responseKind:"handoff",citations:[]})).toThrow();
  });
  it.each(["fr", "en"] as const)("normalizes already formatted %s sections without changing verified instructions", language => {
    const u = understandingFixture({ language }); u.requests.push({ ...u.requests[0], id: "second" });
    const greeting = language === "en" ? "Hello," : "Bonjour,";
    const closing = language === "en" ? "Kind regards," : "Cordialement,";
    const parts = coverageFixture(u).map((part, i) => ({ ...part, text: `${greeting}\n\nInstruction vérifiée ${i + 1}.\n\n${closing}` }));
    const result = assembleSavReplySections(u, styleSavEmailCoverage(u, parts));
    expect(result.replyDraft.split(greeting)).toHaveLength(2);
    expect(result.replyDraft.match(/Bien à vous,|Kind regards,/g)).toHaveLength(1);
    expect(result.replyDraft).toContain("Instruction vérifiée 1.");
    expect(result.replyDraft).toContain("Instruction vérifiée 2.");
    expect(styleSavEmailCoverage(u, result.coverage)).toEqual(result.coverage);
    expect(() => assertSavReplyConsistency(u, { ...result, category: "technical", responseKind: "handoff", citations: [] })).not.toThrow();
  });
});
describe("summarized ticket titles",()=>{
 it("uses the analyzed nominal subject rather than email or summary prefixes",()=>{
  const u=understandingFixture({ticketTitle:"Activation téléphonique et numéro dédié"});
  expect(savTicketTitle(u)).toBe(u.ticketTitle);expect(validSavTicketTitle(u.ticketTitle)).toBe(true);
 });
 it.each(["Bonjour je vous écris pour", "Je souhaite obtenir un numéro", "Re: Merci pour votre réponse", "Titre court", "Activation téléphonique et numéro dédié\nBcc: autre@exemple.invalid"])("rejects an unsuitable generated title: %s",ticketTitle=>{
  const u=understandingFixture({ticketTitle});expect(savTicketTitle(u)).not.toBe(ticketTitle);expect(validSavTicketTitle(savTicketTitle(u))).toBe(true);
 });
 it("does not overwrite a human title, even if longer than the model recommendation",()=>{
  const p=savSemanticE2eProposal();p.ticket.title="Titre précis relu et volontairement plus long par notre équipe";
  p.humanProcess={action:"create_ticket",ticketId:null,confirmed:true,reason:"La demande a été relue pour ce test synthétique",understanding:{primaryRequestId:"r",requests:[{id:"r",summary:"Demande fictive",nature:"technical",product:"",feature:""}],relationship:"unknown",knownFacts:[],attemptedSteps:[],missingInformation:[]}};
  expect(savSuggestedTicketTitle(p)).toBe(p.ticket.title);
 });
 it("keeps previous strict snapshots readable without losing the proposed title",()=>{
  const p=savSemanticE2eProposal();p.understanding!.ticketTitle="Activation téléphonique et numéro dédié";p.ticket.title=p.understanding!.ticketTitle;
  const compatible=savRollbackCompatibleProposal(p);
  expect(compatible.understanding).not.toHaveProperty("ticketTitle");expect(compatible.ticket.title).toBe(p.ticket.title);
  expect(()=>savUnderstandingSchema.omit({ticketTitle:true}).parse(compatible.understanding)).not.toThrow();
 });
});
