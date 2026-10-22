import { savAttachmentDisplayRead, savAttachmentInventorySchema, savAttachmentMetadataSchema, type SavAttachmentRead } from "../attachment-contract";
/** DTO only: Gmail part references, HTML, headers, ownership and raw provider
 * responses must never cross the server/client boundary. */
export function intakeAttachmentBody(body:{text:string;attachments?:unknown[];attachmentInventory?:unknown;attachmentRead?:unknown},derived?:SavAttachmentRead) {
  const inventory=savAttachmentInventorySchema.safeParse(body.attachmentInventory);
  return {text:body.text,attachments:(body.attachments??[]).slice(0,100).flatMap(raw=>{
    const result=savAttachmentMetadataSchema.safeParse(raw);return result.success?[{filename:result.data.filename,mimeType:result.data.mimeType,size:result.data.size}]:[];
  }),attachmentInventory:inventory.success?inventory.data:undefined,attachmentRead:savAttachmentDisplayRead(derived??body.attachmentRead as SavAttachmentRead|undefined)};
}
