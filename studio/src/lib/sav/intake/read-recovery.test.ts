import { expect,it,vi } from "vitest";
import {newReadRecovery,readRecoveryDue,recoverableIntakeReads,intakeReadRetryable} from "./read-recovery";
import type { IntakeAdapters } from "./engine-types";
const config={configHash:"a".repeat(64)},at=new Date("2026-10-25T12:00:00.000Z");
it("bounds technical attempts, spacing, lifetime and config without a semantic counter",()=>{
 const r=newReadRecovery(config,"source",at);r.state="scheduled";r.retryAt=new Date(+at+30000).toISOString();
 expect(readRecoveryDue(r,config,at)).toBeNull();expect(readRecoveryDue(r,config,new Date(+at+30000))).not.toBeNull();
 expect(readRecoveryDue(r,{configHash:"b".repeat(64)},new Date(+at+30000))).toBeNull();
 expect(readRecoveryDue({...r,attempts:3},config,new Date(+at+30000))).toBeNull();
 expect(readRecoveryDue(r,config,new Date(+at+300000))).toBeNull();
 expect(readRecoveryDue({...r,cache:[{method:"ticketHistory",key:"x",resultHash:"x",result:{status:"failed",data:[],observedAt:at.toISOString()}}]},config,new Date(+at+30000))).toBeNull();
});
it.each(["SAV_INTAKE_RUNTIME_CONTEXT_CHANGED","SAV_INTAKE_RUNTIME_REVALIDATION_FAILED","SAV_HUBSPOT_READ_CANCELLED","HUBSPOT_HTTP_401","HUBSPOT_HTTP_403"])("does not retry local/authority/permanent failure %s",code=>expect(intakeReadRetryable(code)).toBe(false));
it("reuses only complete untampered fresh reads with identical operation/arguments",async()=>{
 const state=newReadRecovery(config,"source",at),fn=vi.fn(async()=>({status:"complete" as const,data:[],observedAt:at.toISOString()}));
 const readers=Object.fromEntries(["findContactsByEmail","directAssociations","getContact","ticketsForContact","ticketHistory"].map(k=>[k,fn])) as unknown as IntakeAdapters;
 const original=recoverableIntakeReads(readers,state,{reuse:false,checkpoint:()=>{},now:()=>at});await original.ticketHistory("201",new AbortController().signal);
 const resumed=recoverableIntakeReads(readers,state,{reuse:true,checkpoint:()=>{},now:()=>new Date(+at+31000)});
 expect((await resumed.ticketHistory("201",new AbortController().signal)).observedAt).toBe(at.toISOString());expect(fn).toHaveBeenCalledTimes(1);
 await resumed.ticketHistory("202",new AbortController().signal);expect(fn).toHaveBeenCalledTimes(2);
 state.cache[0].result.data=["edited"];await resumed.ticketHistory("201",new AbortController().signal);expect(fn).toHaveBeenCalledTimes(3);
 const expired=recoverableIntakeReads(readers,state,{reuse:true,checkpoint:()=>{},now:()=>new Date(+at+61000)});await expired.ticketHistory("201",new AbortController().signal);expect(fn).toHaveBeenCalledTimes(4);
});
