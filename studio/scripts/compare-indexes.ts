import { GOLDEN_QUERIES } from "../src/lib/golden-queries";
const legacyModulePath=new URL("../../src/knowledge-base/kb-search.js",import.meta.url).href;
const {searchKB}=await import(legacyModulePath) as {searchKB:(query:string,options:{url:string;consoleLogs:string;maxResults:number;maxChars:number})=>string};
const baseUrl=String(process.env.STUDIO_BASE_URL??"").replace(/\/$/,"");
const token=process.env.STUDIO_SERVICE_TOKEN;
if(!baseUrl||!token) throw new Error("STUDIO_BASE_URL and STUDIO_SERVICE_TOKEN are required");
let remoteTop3=0; let embeddedHasAnswer=0;
for(const test of GOLDEN_QUERIES){
  const embedded=searchKB(test.query,{url:`https://new.limova.ai${test.path}`,consoleLogs:"",maxResults:3,maxChars:8000});
  if(embedded) embeddedHasAnswer+=1;
  const response=await fetch(`${baseUrl}/api/internal/knowledge/search`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({query:test.query,path:test.path,locale:"fr-FR",contentTypes:["article","onboarding"],limit:3})});
  if(!response.ok) throw new Error(`Remote search failed with ${response.status}`);
  const payload=await response.json() as {results:Array<{source:string}>};
  if(payload.results.some(result=>result.source===test.slug)) remoteTop3+=1;
}
console.log(JSON.stringify({questions:GOLDEN_QUERIES.length,embeddedAnswered:embeddedHasAnswer,remoteExpectedTop3:remoteTop3,remoteTop3Rate:remoteTop3/GOLDEN_QUERIES.length},null,2));
if(remoteTop3<GOLDEN_QUERIES.length*.8) process.exitCode=1;
