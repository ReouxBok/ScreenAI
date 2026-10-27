/** SAV-42 A: an unproven optional registration declaration is discarded and
 * diagnosed instead of rejecting an otherwise usable analysis; identity then
 * falls back to the sender. Explicit alternative addresses and identification
 * continuations keep the strict citation check. Synthetic fixtures only. */
import { describe, expect, it, vi } from "vitest";
import { createSavIntakeSemanticReaders, type IntakeGeminiCall, type IntakeModelTrace } from "./model-readers";

const at = "2026-10-21T10:00:00.000Z", mid = "10000000-0000-4000-8000-000000000001", tid = "20000000-0000-4000-8000-000000000001";
const initialMid = "10000000-0000-4000-8000-000000000009";
const message = { id: mid, threadId: tid, receivedAt: at, fromEmail: "sender@example.test", toEmails: ["support@example.test"],
  direction: "inbound" as const, contentComplete: true,
  currentText: "Je souhaite annuler mon essai gratuit. Mon compte est associé à l'adresse e-mail depuis laquelle je vous écris." };
const signal = () => new AbortController().signal;
type Data = { citationCatalogue: { id: string; sourceId: string; text: string }[] };
const data = (arg: Parameters<IntakeGeminiCall>[0]) => JSON.parse(arg.body.contents[0].parts[0].text) as Data;
const anchor = (arg: Parameters<IntakeGeminiCall>[0], source = "current") => data(arg).citationCatalogue.find(a => a.sourceId === source)!.id;
const result = (json: unknown) => ({ json, metadata: { inputTokens: 10, outputTokens: 10, thoughtTokens: 0, totalTokens: 20 } });
const analysis = (arg: Parameters<IntakeGeminiCall>[0], over: Record<string, unknown> = {}) => ({ messageId: mid,
  requests: [{ id: "r0", kind: "cancellation", currentMessageId: mid, quoteId: anchor(arg) }],
  ticketSummary: { title: "Annulation de l'essai", description: "Le client demande l'annulation de son essai gratuit.", requestIds: ["r0"] }, ...over });

function reader(answer: (arg: Parameters<IntakeGeminiCall>[0]) => unknown) {
  const traces: IntakeModelTrace[] = [];
  const call = vi.fn<IntakeGeminiCall>(async arg => result(answer(arg)));
  return { call, traces, model: createSavIntakeSemanticReaders({ model: "gemini-fixture", call, onTrace: t => traces.push(t) }) };
}

describe("current reader: optional registration declaration", () => {
  it("keeps the analysis when the declared sender address is not written literally, and counts the discard", async () => {
    const r = reader(arg => analysis(arg, { registration: { address: "sender@example.test", sourceMessageId: mid, quoteId: anchor(arg) } }));
    const out = await r.model.analyseMessage({ message, conversation: [] }, signal());
    expect(out.requests.map(q => q.kind)).toEqual(["cancellation"]);
    expect(out.registration).toBeUndefined();
    expect(r.call).toHaveBeenCalledTimes(1);
    expect(r.traces).toHaveLength(1);
    expect(r.traces[0]).toMatchObject({ accepted: true, errorCode: null, normalization: { discardedRegistrations: 1 } });
  });
  it("never adopts an unproven alternative address: it is discarded, identity stays the sender's", async () => {
    const r = reader(arg => analysis(arg, { registration: { address: "invented@example.test", sourceMessageId: mid, quoteId: anchor(arg) } }));
    const out = await r.model.analyseMessage({ message, conversation: [] }, signal());
    expect(out.registration).toBeUndefined();
    expect(JSON.stringify(r.traces)).not.toContain("invented@example.test");
  });
  it("never takes a registration from an outbound message; the declaration is discarded", async () => {
    const outbound = { ...message, id: tid, direction: "outbound" as const, currentText: "L'adresse d'inscription est other@example.test." };
    const r = reader(arg => analysis(arg, { registration: { address: "other@example.test", sourceMessageId: outbound.id, quoteId: anchor(arg, `message-${outbound.id}`) } }));
    const out = await r.model.analyseMessage({ message, conversation: [outbound] }, signal());
    expect(out.registration).toBeUndefined();
  });
  it("keeps a valid explicit alternative declaration unchanged", async () => {
    const text = "Je souhaite annuler mon essai. Mon compte est client@entreprise.test";
    const r = reader(arg => analysis(arg, { registration: { address: "client@entreprise.test", sourceMessageId: mid, quoteId: anchor(arg) } }));
    const out = await r.model.analyseMessage({ message: { ...message, currentText: text }, conversation: [] }, signal());
    expect(out.registration).toMatchObject({ address: "client@entreprise.test", sourceMessageId: mid });
    expect(r.traces[0].normalization).toBeUndefined();
  });
  it("still rejects an unproven declaration when the current text names another address (explicit alternative must be verified)", async () => {
    const text = "Je souhaite annuler. Mon compte est client@entreprise.test et merci.";
    const r = reader(arg => analysis(arg, { registration: { address: "autre@entreprise.test", sourceMessageId: mid,
      quoteId: data(arg).citationCatalogue.find(a => a.sourceId === "current")!.id } }));
    await expect(r.model.analyseMessage({ message: { ...message, currentText: text }, conversation: [] }, signal())).rejects.toThrow("CITATION_REJECTED");
    expect(r.traces.at(-1)?.validationFailure?.reason).toBe("registration_source_invalid");
  });
  it("still rejects an unproven declaration that carries inherited requests of an identification continuation", async () => {
    const initial = { ...message, id: initialMid, receivedAt: "2026-10-20T10:00:00.000Z", currentText: "Mon agenda ne se synchronise plus." };
    const r = reader(arg => analysis(arg, {
      requests: [{ id: "r0", kind: "support", currentMessageId: mid, originMessageId: initialMid, quoteId: anchor(arg, `message-${initialMid}`) }],
      registration: { address: "sender@example.test", sourceMessageId: mid, quoteId: anchor(arg) } }));
    await expect(r.model.analyseMessage({ message, conversation: [initial], identificationContinuation: { initialMessageId: initialMid, confirmedEffectId: "effect-1" } }, signal()))
      .rejects.toThrow("CITATION_REJECTED");
  });
});

it("REVIEW an invalid optional registration anchor does not discard the otherwise proven request", async () => {
  const r = reader(arg => analysis(arg, { registration: { address: "sender@example.test", sourceMessageId: mid, quoteId: "unknown-optional-anchor" } }));
  const out = await r.model.analyseMessage({ message, conversation: [] }, signal());
  expect(out.requests.map(q => q.kind)).toEqual(["cancellation"]);
  expect(out.registration).toBeUndefined();
  expect(r.traces.at(-1)?.normalization?.discardedRegistrations).toBe(1);
});

it.each([false,true])("REVIEW201 an optional registration anchor does not reject the visual path (unknown=%s)",async invalid=>{
 const {admitSavAttachmentImage}=await import("../attachment-image");
 const sharp=(await import("sharp")).default;
 const image=await admitSavAttachmentImage(await sharp({create:{width:1,height:1,channels:3,background:{r:0,g:0,b:0}}}).png().toBuffer(),"image/png");
 const observation={sourceId:"image-1",filename:"synthetic.png",mimeType:"image/png",referenceHash:"synthetic",fileHash:image.hash,width:1,height:1,status:"not_read" as const,reason:"in_progress" as const,text:"",uncertainties:[],regions:[]};
 const prepared={observations:[observation],selected:[{observation,image,imageIndex:0}],uniqueImages:[image]};
 const traces:IntakeModelTrace[]=[];
 const call=vi.fn<IntakeGeminiCall>(async arg=>{
  const raw=analysis(arg,{registration:{address:"sender@example.test",sourceMessageId:mid,quoteId:invalid?"unknown-optional-anchor":anchor(arg)},images:[{index:0,readability:"readable",text:"Synthetic error",uncertainties:[],regions:[]}],imageRequirements:[{sourceId:observation.sourceId,fileHash:image.hash,role:"accessory",textQuoteId:anchor(arg)}]});
  return result(arg.sanitizeResponse?arg.sanitizeResponse(raw):raw);
 });
 const r=createSavIntakeSemanticReaders({model:"gemini-fixture",call,onTrace:t=>traces.push(t),attachments:{prepared,onRead:()=>{}}});
 const out=await r.analyseMessage({message,conversation:[]},signal());
 expect(out.requests.map(q=>q.kind)).toEqual(["cancellation"]);expect(out.registration).toBeUndefined();expect(call).toHaveBeenCalledTimes(1);
});

describe("SAV-42 A (review 201): visual path keeps every other field strict", () => {
  const visualReader = async (request: (arg: Parameters<IntakeGeminiCall>[0]) => Record<string, unknown>) => {
    const { admitSavAttachmentImage } = await import("../attachment-image");
    const sharp = (await import("sharp")).default;
    const image = await admitSavAttachmentImage(await sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer(), "image/png");
    const observation = { sourceId: "image-1", filename: "synthetic.png", mimeType: "image/png", referenceHash: "synthetic", fileHash: image.hash, width: 1, height: 1,
      status: "not_read" as const, reason: "in_progress" as const, text: "", uncertainties: [], regions: [] };
    const prepared = { observations: [observation], selected: [{ observation, image, imageIndex: 0 }], uniqueImages: [image] };
    const traces: IntakeModelTrace[] = [];
    const call = vi.fn<IntakeGeminiCall>(async arg => {
      const raw = { ...request(arg), images: [{ index: 0, readability: "readable", text: "Synthetic error", uncertainties: [], regions: [] }],
        imageRequirements: [{ sourceId: observation.sourceId, fileHash: image.hash, role: "accessory", textQuoteId: anchor(arg) }] };
      return result(arg.sanitizeResponse ? arg.sanitizeResponse(raw) : raw);
    });
    return { traces, call, model: createSavIntakeSemanticReaders({ model: "gemini-fixture", call, onTrace: t => traces.push(t), attachments: { prepared, onRead: () => {} } }) };
  };
  it("REVIEWCA a visual identification continuation keeps its required registration strict",async()=>{
    const initial={...message,id:initialMid,receivedAt:"2026-10-20T10:00:00.000Z",currentText:"Mon agenda ne se synchronise plus."};
    const r=await visualReader(arg=>analysis(arg,{requests:[{id:"r0",kind:"support",currentMessageId:mid,originMessageId:initialMid,quoteId:anchor(arg,`message-${initialMid}`)}],registration:{address:"sender@example.test",sourceMessageId:mid,quoteId:"unknown-registration-anchor"}}));
    await expect(r.model.analyseMessage({message,conversation:[initial],identificationContinuation:{initialMessageId:initialMid,confirmedEffectId:"effect-1"}},signal())).rejects.toThrow();
    expect(r.call).toHaveBeenCalledTimes(1);
    expect(r.traces.at(-1)?.normalization?.discardedRegistrations??0).toBe(0);
  });
  it("counts a dropped unanchored registration exactly once, with a single image call", async () => {
    const r = await visualReader(arg => analysis(arg, { registration: { address: "sender@example.test", sourceMessageId: mid, quoteId: "unknown-optional-anchor" } }));
    const out = await r.model.analyseMessage({ message, conversation: [] }, signal());
    expect(out.registration).toBeUndefined();
    expect(r.call).toHaveBeenCalledTimes(1);
    expect(r.traces.at(-1)).toMatchObject({ accepted: true, normalization: { discardedRegistrations: 1 } });
  });
  it("still rejects an unknown request anchor on the visual path, without a second image call", async () => {
    const r = await visualReader(arg => analysis(arg, { requests: [{ id: "r0", kind: "cancellation", currentMessageId: mid, quoteId: "unknown-request-anchor" }] }));
    await expect(r.model.analyseMessage({ message, conversation: [] }, signal())).rejects.toThrow();
    expect(r.call).toHaveBeenCalledTimes(1);
  });
  it("still rejects an unanchored registration when the text names another address", async () => {
    const r = await visualReader(arg => analysis(arg, { registration: { address: "autre@entreprise.test", sourceMessageId: mid, quoteId: "unknown-optional-anchor" } }));
    await expect(r.model.analyseMessage({ message: { ...message, currentText: "Je souhaite annuler. Mon compte est client@entreprise.test" }, conversation: [] }, signal())).rejects.toThrow();
  });
});
