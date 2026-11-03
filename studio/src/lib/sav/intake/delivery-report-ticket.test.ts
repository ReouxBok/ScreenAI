import { describe, expect, it, vi } from "vitest";
import { resolveDeliveryReportTicket } from "./delivery-report-ticket";

const parent = "<out@example.invalid>";
const sent = {id:"sent",direction:"outbound",fromEmail:"sav@example.invalid",headers:{"x-studio-automation-headers":"singleton-v1","message-id":parent}};
const notice = {id:"dsn",direction:"inbound",fromEmail:"dsn@example.invalid",headers:{"x-studio-automation-headers":"singleton-v1","content-type":"multipart/report; report-type=delivery-status","in-reply-to":parent}};
const props = {hs_email_message_id:parent,hs_email_direction:"EMAIL",hs_email_from_email:sent.fromEmail,hs_email_status:"SENT"};
const hit = {id:"111",properties:props};
const one = {total:1,results:[hit]};
const associations = {results:[{toObjectId:222}]};
function fixture(search: unknown = one, tickets:unknown = associations) {
  return vi.fn(async (path:string,body?:unknown)=>{
    if (path === "/crm/v3/objects/emails/search" && body) return search;
    if (path === "/crm/v4/objects/emails/111/associations/tickets?limit=2" && !body) return tickets;
    throw Error("UNEXPECTED_REQUEST");
  });
}
describe("delivery report operator evidence",()=>{
  it("proposes only the ticket of an exact, sent, uniquely associated CRM email",async()=>{
    const read=fixture();
    expect(await resolveDeliveryReportTicket([sent,notice],"dsn",read)).toMatchObject({ok:true,emailId:"111",ticketId:"222",receipt:{state:"unverified"}});
    expect(read.mock.calls).toHaveLength(2);
    expect(read.mock.calls[0][1]).toMatchObject({filterGroups:[{filters:[{propertyName:"hs_email_message_id",operator:"EQ",value:parent}]}]});
  });
  it.each([["duplicate RFC", [sent,{...sent,id:"other"},notice]],
    ["legacy outbound without parser proof",[{...sent,headers:{"message-id":parent}},notice]],
    ["ambiguous notice headers",[sent,{...notice,headers:{...notice.headers,"x-studio-automation-headers":"ambiguous"}}]],
    ["subject only", [sent,{...notice,headers:{"in-reply-to":parent}}]],
    ["References ancestor only", [sent,{...notice,headers:{"content-type":notice.headers["content-type"],references:parent}}]],
    ["other parent", [sent,{...notice,headers:{...notice.headers,"in-reply-to":"<other@example.invalid>"}}]] ] as const)(
    "makes no CRM request for %s",async (_label,mail)=>{
      const read=fixture();expect(await resolveDeliveryReportTicket([...mail],"dsn",read)).toMatchObject({ok:false});
      expect(read).not.toHaveBeenCalled();
  });
  it.each([
    ["duplicate CRM email",{total:2,results:[hit,hit]},associations],
    ["partial CRM search",{...one,paging:{next:{after:"2"}}},associations],
    ["wrong RFC",{total:1,results:[{...hit,properties:{...props,hs_email_message_id:"<other@example.invalid>"}}]},associations],
    ["wrong mailbox",{total:1,results:[{...hit,properties:{...props,hs_email_from_email:"else@example.invalid"}}]},associations],
    ["unsent",{total:1,results:[{...hit,properties:{...props,hs_email_status:"QUEUED"}}]},associations],
    ["inbound",{total:1,results:[{...hit,properties:{...props,hs_email_direction:"INCOMING_EMAIL"}}]},associations],
    ["no ticket",one,{results:[]}],
    ["two tickets",one,{results:[{toObjectId:1},{toObjectId:2}]}],
    ["partial ticket page",one,{...associations,paging:{next:{after:"3"}}}],
    ["unsafe numeric ID",one,{results:[{toObjectId:9007199254740992}]}],
  ])("preserves manual review for %s",async (_label,search,tickets)=>{
    expect(await resolveDeliveryReportTicket([sent,notice],"dsn",fixture(search,tickets))).toMatchObject({ok:false});
  });
  it.each([
    ["associated", {results:[{toObjectId:222}]}], ["unassociated", {results:[]}],
    ["unverified",{results:[{toObjectId:444}]}], ["unverified",{results:[{toObjectId:222},{toObjectId:444}]}],
    ["unverified",{results:[{toObjectId:222}],paging:{next:{after:"3"}}}],
  ])("reads the notice receipt on two visits: %s",async (state,links)=>{
    const ownId="<notice@example.invalid>";
    const withId={...notice,headers:{...notice.headers,"message-id":ownId}};
    const ownSearch={total:1,results:[{id:"333",properties:{hs_email_message_id:ownId,hs_email_direction:"INCOMING_EMAIL",hs_email_from_email:notice.fromEmail}}]};
    const reader=vi.fn(async(path:string,body?:unknown)=>{
      if (path==="/crm/v3/objects/emails/search") return JSON.stringify(body).includes(ownId) ? ownSearch : one;
      if (path==="/crm/v4/objects/emails/111/associations/tickets?limit=2") return associations;
      if (path==="/crm/v4/objects/emails/333/associations/tickets?limit=2") return links;
      throw Error("WRITE_FORBIDDEN");
    });
    for (let visit=0;visit<2;visit++) expect(await resolveDeliveryReportTicket([sent,withId],"dsn",reader))
      .toMatchObject({ok:true,emailId:"111",ticketId:"222",receipt:{state,...(state==="unverified"?{}:{emailId:"333"})}});
    expect(reader).toHaveBeenCalledTimes(8);
    expect(reader.mock.calls.every(([path,body])=>body ? path==="/crm/v3/objects/emails/search" : path.includes("/associations/tickets?"))).toBe(true);
  });
  it("reports unavailable access without proposing a ticket",async()=>{
    expect(await resolveDeliveryReportTicket([sent,notice],"dsn",async()=>{throw Error("HTTP_403")})).toEqual({ok:false,reason:"Lecture HubSpot indisponible. Le rattachement reste à vérifier."});
  });
});
