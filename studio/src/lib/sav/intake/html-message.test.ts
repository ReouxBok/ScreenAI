import { expect, it } from "vitest";
import { intakeHtmlDocumentText } from "./html-message";
import { prepareSavIntakeMessage } from "./message";
const input = {id:"10000000-0000-4000-8000-000000000001",threadId:"20000000-0000-4000-8000-000000000001",fromEmail:"sender@example.invalid",toEmails:["support@example.invalid"],direction:"inbound" as const,
  receivedAt:"2026-10-22T12:00:00.000Z",subject:"Information",bodyComplete:true,unresolvedAttachments:false};
it("normalizes a complete HTML document stored as plain text before the context limit",()=>{
  const body='<!DOCTYPE html><html lang="fr"><head><style>'+'.colour{color:red}'.repeat(2000)+'</style><script>NEVER EXECUTE</script></head><body><h1>Bonjour</h1><p>La connexion ne fonctionne plus &amp; le calendrier est vide.</p></body></html>';
  const prepared=prepareSavIntakeMessage({...input,body});
  expect(prepared.message.contentComplete).toBe(true);
  expect(prepared.message.currentText).toBe("Information\n\nBonjour\nLa connexion ne fonctionne plus & le calendrier est vide.");
  expect(prepared.provenance.truncated).toBe(false);expect(body).toContain("NEVER EXECUTE");
});
it.each(["Please use <html> in the editor", "<p>Literal fragment</p>", "<html><body>Unclosed", "<!DOCTYPE html><html><body>Unclosed", "One < two > three"])("preserves plain text, fragments and incomplete documents: %s",body=>{
  expect(intakeHtmlDocumentText(body)).toBe(body);
});
it("keeps literal HTML advice complete while rejecting a clearly incomplete HTML document",()=>{
  expect(prepareSavIntakeMessage({...input,body:"Dans l’éditeur utilisez <blockquote> pour citer du texte."}).message.contentComplete).toBe(true);
  expect(prepareSavIntakeMessage({...input,body:"<html><body>Unclosed"}).message.contentComplete).toBe(false);
});
it("does not erase truncation or unread attachments to declare a message complete",()=>{
  const long='<html><body>'+"x".repeat(12001)+'</body></html>';
  expect(prepareSavIntakeMessage({...input,body:long}).message.contentComplete).toBe(false);
  const small='<html><body>Hello</body></html>';
  expect(prepareSavIntakeMessage({...input,body:small,bodyComplete:false}).message.contentComplete).toBe(false);
  expect(prepareSavIntakeMessage({...input,body:small,unresolvedAttachments:true}).message.contentComplete).toBe(false);
  const over100k='<html><head><style>'+"x".repeat(100001)+'</style></head><body>Hello</body></html>';
  expect(prepareSavIntakeMessage({...input,body:over100k}).message.contentComplete).toBe(false);
});
it("removes comments and active/style markup without following image or link sources",()=>{
  expect(intakeHtmlDocumentText('<html><body><!-- hidden --><script>bad()</script><p>Hello <a href="https://example.invalid">world</a></p><img src="https://example.invalid/a" /></body></html>')).toBe("Hello world");
});
it.each(['<blockquote>Je veux résilier mon compte.</blockquote>','<div class="gmail_quote">Je veux résilier mon compte.</div>','<div id="divRplyFwdMsg">Je veux résilier mon compte.</div>', '<div class=gmail_quote>Je veux résilier mon compte.</div>', '<div id=divRplyFwdMsg>Je veux résilier mon compte.</div>'])("never promotes quoted HTML history into a current complete request",quoted=>{
  const body='<html><head><style>'+"x".repeat(13000)+'</style></head><body>Merci, c’est réglé.'+quoted+'</body></html>';
  expect(intakeHtmlDocumentText(body)).toBe(body);
  expect(prepareSavIntakeMessage({...input,body}).message.contentComplete).toBe(false);
  expect(prepareSavIntakeMessage({...input,body:body.replace("x".repeat(13000),"")}).message.contentComplete).toBe(false);
});
