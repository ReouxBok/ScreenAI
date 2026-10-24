import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/db", () => ({ requireDb: () => { throw Error("DB_FORBIDDEN"); } }));
import { markHandledGmailMessageRead, syncHandledIntakeGmailRead } from "./gmail-read";
import type { GmailRequest } from "./execution-adapters";
afterEach(() => vi.unstubAllEnvs());
const source = { mailboxEmail: "contact@limova.ai", gmailMessageId: "1a123", gmailThreadId: "1a000" };
function provider(options: { wrongMailbox?: boolean; wrongThread?: boolean; keepUnread?: boolean; failAfterWrite?: boolean; read?: boolean } = {}) {
  let read = Boolean(options.read), writes = 0;
  const calls: { path: string; init?: RequestInit }[] = [];
  const request: GmailRequest = async <T>(_mailbox: string, path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if (path === "profile") return { emailAddress: options.wrongMailbox ? "ugo@limova.ai" : source.mailboxEmail } as T;
    if (path.endsWith("/modify")) {
      writes++; if (!options.keepUnread) read = true;
      if (options.failAfterWrite) throw Error("TIMEOUT");
      return {} as T;
    }
    return { id: source.gmailMessageId, threadId: options.wrongThread ? "other" : source.gmailThreadId, labelIds: ["INBOX", "Label_kept", ...read ? [] : ["UNREAD"]] } as T;
  };
  return { request, calls, writes: () => writes };
}
it("removes UNREAD from the exact handled message, preserving INBOX and other labels", async () => {
  const p = provider(), guard = vi.fn(async () => {});
  expect(await markHandledGmailMessageRead(source, p.request, guard)).toEqual({ alreadyRead: false });
  expect(guard).toHaveBeenCalledTimes(1);expect(p.writes()).toBe(1);
  expect(p.calls.find(x => x.init?.method === "POST")).toMatchObject({path:"messages/1a123/modify",init:{body:JSON.stringify({removeLabelIds:["UNREAD"]})}});
  expect(p.calls.some(x => x.path.startsWith("threads/") || /send|draft/.test(x.path))).toBe(false);
});
it("already read needs no mutation",async()=>{
  const p=provider({read:true}),guard=vi.fn(async()=>{});expect(await markHandledGmailMessageRead(source,p.request,guard)).toEqual({alreadyRead:true});expect(p.writes()).toBe(0);expect(guard).not.toHaveBeenCalled();
});
it.each(["wrongMailbox","wrongThread"] as const)("refuses %s before any modification",async key=>{
  const p=provider({[key]:true});await expect(markHandledGmailMessageRead(source,p.request,async()=>{})).rejects.toThrow(/MISMATCH/);expect(p.writes()).toBe(0);
});
it("revoked authority stops the modification",async()=>{
  const p=provider();await expect(markHandledGmailMessageRead(source,p.request,async()=>{throw Error("REVOKED");})).rejects.toThrow("REVOKED");expect(p.writes()).toBe(0);
});
it("verifies the provider result and refuses a remaining UNREAD",async()=>{
  const p=provider({keepUnread:true});await expect(markHandledGmailMessageRead(source,p.request,async()=>{})).rejects.toThrow("UNCONFIRMED");
});
it("an uncertain modify is recovered through metadata GET without a second mutation",async()=>{
  const p=provider({failAfterWrite:true});await expect(markHandledGmailMessageRead(source,p.request,async()=>{})).rejects.toThrow("TIMEOUT");
  expect(await markHandledGmailMessageRead(source,p.request,async()=>{})).toEqual({alreadyRead:true});expect(p.writes()).toBe(1);
});
it("disabled by default before database or network access",async()=>{
  const gmail=vi.fn();expect(await syncHandledIntakeGmailRead("unused",{env:()=>({}),gmail})).toEqual({skipped:"off"});expect(gmail).not.toHaveBeenCalled();
});
it("invalid source and a different mailbox cannot be used",async()=>{
  const p=provider();await expect(markHandledGmailMessageRead({...source,mailboxEmail:"ugo@limova.ai"},p.request,async()=>{})).rejects.toThrow("SOURCE_INVALID");expect(p.calls).toHaveLength(0);
});
