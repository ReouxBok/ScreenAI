import "server-only";
import {requestSavHubspot} from "../hubspot-transport";
import {crmDisplayFallback,type CrmDisplay,type CrmDisplayRecord} from "./crm-display";
/** Called only after the dossier's staff authorization. Display metadata never
 * participates in source hashes, matching or permissions. No mutation endpoints. */
export async function readIntakeCrmDisplay(contactIds:string[],ticketIds:string[]):Promise<CrmDisplay> {
  const portal=process.env.HUBSPOT_PORTAL_ID,token=process.env.HUBSPOT_ACCESS_TOKEN;
  async function batch(kind:"contact"|"ticket",values:string[]):Promise<Record<string,CrmDisplayRecord>> {
    const ids=[...new Set(values.filter(id=>/^\d{1,30}$/.test(id)))].slice(0,100);
    const records=Object.fromEntries(ids.map(id=>[id,crmDisplayFallback(portal,kind,id)]));
    if(!ids.length||!token||!portal||!/^\d{1,30}$/.test(portal))return records;
    try {
      const result=await requestSavHubspot<{results?:unknown[];status?:string;errors?:unknown[]}>(`/crm/v3/objects/${kind==="contact"?"contacts":"tickets"}/batch/read`,{
        method:"POST",redirect:"error",signal:AbortSignal.timeout(5000),headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
        body:JSON.stringify({properties:kind==="contact"?["firstname","lastname","email"]:["subject"],inputs:ids.map(id=>({id}))}),
      },status=>`HUBSPOT_HTTP_${status}`);
      if(!Array.isArray(result.results)||result.status!=="COMPLETE"||result.errors?.length)return records;
      for(const value of result.results) {
        if(!value||typeof value!=="object")continue;
        const row=value as {id?:unknown;archived?:unknown;properties?:Record<string,unknown>};
        if(typeof row.id!=="string"||!records[row.id]||row.archived===true||!row.properties)continue;
        const clean=(key:string)=>typeof row.properties![key]==="string"?(row.properties![key] as string).trim().slice(0,300):"";
        const label=kind==="contact"?[clean("firstname"),clean("lastname")].filter(Boolean).join(" ")||clean("email"):clean("subject");
        if(label)records[row.id]={...records[row.id],label,available:true};
      }
    } catch { /* A display read cannot turn into an invented name or change the dossier. */ }
    return records;
  }
  const [contacts,tickets]=await Promise.all([batch("contact",contactIds),batch("ticket",ticketIds)]);
  return {contacts,tickets};
}
