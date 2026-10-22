export type CrmDisplayRecord = {label:string;url:string|null;available:boolean};
export type CrmDisplay = {contacts:Record<string,CrmDisplayRecord>;tickets:Record<string,CrmDisplayRecord>};
export function crmRecordUrl(portal:string|undefined,kind:"contact"|"ticket",id:string):string|null {
  return portal && /^\d{1,30}$/.test(portal) && /^\d{1,30}$/.test(id)
    ? `https://app.hubspot.com/contacts/${portal}/${kind}/${id}` : null;
}
export const crmDisplayFallback=(portal:string|undefined,kind:"contact"|"ticket",id:string):CrmDisplayRecord=>({
  label:kind==="contact"?"Fiche client — nom indisponible":"Ticket — sujet indisponible",url:crmRecordUrl(portal,kind,id),available:false,
});
