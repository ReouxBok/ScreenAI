import "server-only";
import { desc, eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { savMessages } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { savEffectiveReceivedAt } from "../message-order";
import { requestSavHubspot } from "../hubspot-transport";
import { isDeliveryReportMime } from "../observation-source";
import { isHubspotOutboundDirection } from "../learning-extraction";

type Mail = { id:string; direction:string; fromEmail:string; headers:unknown };
export type DeliveryNoticeReceipt =
  | { state:"associated"; emailId:string; providerUrl?:string }
  | { state:"unassociated"; emailId:string; providerUrl?:string }
  | { state:"unverified"; reason:string };
type Target = { ok:true; ticketId:string; emailId:string; receipt:DeliveryNoticeReceipt } | { ok:false; reason:string };
const unresolved = (reason:string): Target => ({ok:false,reason});
const numericId = (s:unknown): s is string => typeof s === "string" && /^\d{1,30}$/.test(s);
const rfcId = /^<[^<>\s@]+@[^<>\s@]+>$/;
function header(mail:Mail, name:string) {
  if (!mail.headers || typeof mail.headers !== "object" || Array.isArray(mail.headers)) return "";
  const value = (mail.headers as Record<string, unknown>)[name];
  return typeof value === "string" ? value.trim() : "";
}

/** Use a provider-supplied link only for the exact verified email in this portal. */
export function deliveryEmailUrl(receipt: DeliveryNoticeReceipt, portal: string | undefined): string | null {
  if (receipt.state === "unverified" || !receipt.providerUrl || !numericId(portal) || !numericId(receipt.emailId)) return null;
  try {
    const url = new URL(receipt.providerUrl);
    if (url.origin !== "https://app.hubspot.com" || url.username || url.password ||
        url.pathname !== `/contacts/${portal}/record/0-49/${receipt.emailId}`) return null;
    return url.origin + url.pathname;
  } catch { return null; }
}

type Read = (path:string,body?:unknown)=>Promise<unknown>;
type EmailHit = {id:string;url?:unknown;archived?:boolean;properties?:Record<string,string>};
async function findEmail(read:Read, identity:string) {
  return await read("/crm/v3/objects/emails/search", {
    filterGroups:[{filters:[{propertyName:"hs_email_message_id",operator:"EQ",value:identity}]}],
    properties:["hs_email_message_id","hs_email_direction","hs_email_status","hs_email_from_email"],limit:2
  }) as { total?:number; paging?:{next?:unknown}; results?:EmailHit[] };
}
async function deliveryNoticeReceipt(read:Read,notice:Mail,parent:string,ticketId:string):Promise<DeliveryNoticeReceipt> {
  const identity=header(notice,"message-id");
  if (!rfcId.test(identity) || identity===parent || !notice.fromEmail)
    return {state:"unverified",reason:"L’avis ne possède pas un identifiant propre vérifiable."};
  try {
    const search=await findEmail(read,identity);
    const hit=search?.results?.[0],props=hit?.properties;
    if (!Array.isArray(search?.results) || search?.total!==1 || search.results.length!==1 || search.paging?.next || !numericId(hit?.id) || hit.archived===true ||
      props?.hs_email_message_id!==identity || props.hs_email_direction!=="INCOMING_EMAIL" ||
      props.hs_email_from_email?.trim().toLowerCase()!==notice.fromEmail.trim().toLowerCase())
      return {state:"unverified",reason:"Aucune activité entrante unique et vérifiée pour l’avis lui-même."};
    const links=await read(`/crm/v4/objects/emails/${hit.id}/associations/tickets?limit=2`) as {results?:Array<{toObjectId?:unknown}>;paging?:{next?:unknown}};
    if (!Array.isArray(links?.results) || links.paging?.next) return {state:"unverified",reason:"La liste des tickets de l’avis est incomplète."};
    const record = {emailId:hit.id, ...(typeof hit.url === "string" ? {providerUrl:hit.url} : {})};
    if (!links.results.length) return {state:"unassociated",...record};
    const linked=links.results[0]?.toObjectId;
    if (links.results.length===1 && (typeof linked==="string" || typeof linked==="number" && Number.isSafeInteger(linked)) && String(linked)===ticketId)
      return {state:"associated",...record};
    return {state:"unverified",reason:"L’avis est associé à un autre ticket ou à plusieurs tickets. Vérification humaine requise."};
  } catch { return {state:"unverified",reason:"Lecture du reçu de l’avis indisponible."}; }
}

// Require a single direct parent. An older ancestor in References alone may belong to
// a different ticket. The operator can still investigate those cases manually.
export async function resolveDeliveryReportTicket(messages:Mail[], currentId:string,
  read:Read):Promise<Target> {
  const current = messages.find(m => m.id === currentId);
  if (!current || current.direction !== "inbound" || header(current,"x-studio-automation-headers") !== "singleton-v1" ||
      !isDeliveryReportMime(header(current,"content-type")))
    return unresolved("Le message courant ne prouve pas un avis de distribution.");
  const parent = header(current,"in-reply-to");
  const matches = messages.filter(m => header(m,"message-id") === parent);
  if (!rfcId.test(parent) || matches.length !== 1 || matches[0].direction !== "outbound" ||
      header(matches[0],"x-studio-automation-headers") !== "singleton-v1")
    return unresolved("Aucun message sortant unique de ce fil n’est identifié comme parent direct.");
  try {
    const search = await findEmail(read,parent);
    const rows = search?.results, hit = rows?.[0], props = hit?.properties;
    if (!Array.isArray(rows) || search.total !== 1 || rows.length !== 1 || search.paging?.next || !numericId(hit?.id) ||
        hit?.archived === true || props?.hs_email_message_id !== parent || !isHubspotOutboundDirection(props.hs_email_direction ?? "") ||
        props.hs_email_status !== "SENT" || !matches[0].fromEmail || props.hs_email_from_email?.trim().toLowerCase() !== matches[0].fromEmail.trim().toLowerCase())
      return unresolved("Le mail sortant envoyé n’a pas été retrouvé de façon unique dans HubSpot.");
    const assoc = await read(`/crm/v4/objects/emails/${hit.id}/associations/tickets?limit=2`) as {
      results?:Array<{toObjectId?:unknown}>;paging?:{next?:unknown} };
    const target = assoc?.results?.[0]?.toObjectId;
    const ticketId = typeof target === "number" && Number.isSafeInteger(target) ? String(target) : target;
    if (!Array.isArray(assoc?.results) || assoc.results.length !== 1 || assoc.paging?.next || !numericId(ticketId))
      return unresolved("Le mail sortant n’a pas une seule association de ticket vérifiable dans HubSpot.");
    return {ok:true,ticketId,emailId:hit.id,receipt:await deliveryNoticeReceipt(read,current,parent,ticketId)};
  } catch {
    return unresolved("Lecture HubSpot indisponible. Le rattachement reste à vérifier.");
  }
}

/** Read-only receipt from the staff-authorized current dossier page. */
export async function readDeliveryReportTicket(threadId:string, currentId:string):Promise<Target> {
  const rows = await requireDb().select().from(savMessages).where(eq(savMessages.threadId,threadId))
    .orderBy(desc(savEffectiveReceivedAt),desc(savMessages.createdAt),desc(savMessages.id)).limit(201);
  if (rows.length > 200 || rows.find(m=>m.direction==="inbound")?.id !== currentId)
    return unresolved("Le message courant a changé ou le fil dépasse la limite de vérification.");
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) return unresolved("Lecture HubSpot indisponible. Le rattachement reste à vérifier.");
  const signal = AbortSignal.timeout(8000);
  return resolveDeliveryReportTicket(rows.map(row=>({
    id:row.id,direction:row.direction,fromEmail:row.fromEmail,headers:decryptSavPayload<{headers?:unknown}>(row.bodyCiphertext).headers
  })),currentId,(path,body)=>requestSavHubspot(path,{method:body ? "POST":"GET",redirect:"error",signal,
    headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},...(body ? {body:JSON.stringify(body)}:{})},
    status=>`HUBSPOT_HTTP_${status}`));
}
