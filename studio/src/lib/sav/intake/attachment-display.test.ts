import {expect,it} from "vitest";
import {attachmentMetadata,observedAttachment} from "../../../../test/sav-attachments";
import {intakeAttachmentBody} from "./attachment-display";
it("projects observations without provider references or claims and starts no reader",()=>{
 const item=attachmentMetadata(),read=observedAttachment();
 const body=intakeAttachmentBody({text:"Synthetic mail",attachments:[item],attachmentInventory:{complete:true,limits:[]}},read);
 expect(body.attachmentRead?.observations[0].text).toContain("E42");
 for(const key of ["attachmentId","gmailMessageId","gmailThreadId","mailboxEmail","claimId"])expect(JSON.stringify(body)).not.toContain(key);
 expect(body.attachments[0]).toEqual({filename:item.filename,mimeType:item.mimeType,size:item.size});
});
it("keeps empty truncated inventories visible and unknown old inventories unknown",()=>{
 expect(intakeAttachmentBody({text:"mail",attachments:[],attachmentInventory:{complete:false,limits:["node_limit"]}}).attachmentInventory?.complete).toBe(false);
 expect(intakeAttachmentBody({text:"old"}).attachmentInventory).toBeUndefined();
});
