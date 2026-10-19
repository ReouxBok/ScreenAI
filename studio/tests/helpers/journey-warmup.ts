import {expect,type APIRequestContext} from "@playwright/test";
// Compile the local dev routes without starting a workflow, action or provider call.
// This is excluded from the journey's interaction timing; it proves no production latency.
export async function warmSavJourneyRoutes({request}:{request:APIRequestContext}) {
 for(const [endpoint,status] of [["/.well-known/workflow/v1/flow",400],["/.well-known/workflow/v1/step",405]] as const){
  const response=await request.get(endpoint,{timeout:90000});expect(response.status()).toBe(status);
 }
 const response=await request.get("/api/internal/sav/dossiers/not-a-uuid/status",{timeout:90000});expect(response.status()).toBe(400);
}
