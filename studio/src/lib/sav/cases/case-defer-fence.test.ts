// Mechanical test of `deferEffect`: the lease is judged AGAIN after the effect lock is taken (fake clock, mocked transaction, no database).
// Technique and cases from the independent review probe (review-C/DEFER_PROBES.patch), kept here as a regression test.
import {afterEach,describe,it,expect,vi} from "vitest";
const state=vi.hoisted(()=>({db:null as unknown}));vi.mock("@/db",()=>({requireDb:()=>state.db}));
import {createCaseEffectDriver} from "./case-effect-driver";
import {savCaseEffectExecutions,savIntakeEffects} from "@/db/schema";
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
describe("deferEffect: the lease is judged again after the effect lock",()=>{
 it.each(["valid","expired-before-first","expires-after-effect-lock"])("%s keeps the attempt iff lease is still live",async mode=>{
 vi.stubEnv("SAV_ENCRYPTION_KEY_V1","synthetic-execution-encryption-key-32-characters");vi.useFakeTimers({toFake:["Date"]});const t=Date.parse("2026-10-31T10:00:00Z");vi.setSystemTime(t);let effectLocks=0,updates=0;
 const execution={id:"10000000-0000-4000-8000-000000000001",leaseToken:"lease-syn",leaseUntil:new Date(t+1000),state:"running"};const effect={id:"20000000-0000-4000-8000-000000000001",executionId:execution.id,attemptId:"attempt-syn",dispatchToken:execution.leaseToken,state:"dispatched",reconcileAttempts:0};
 const tx={select:()=>({from:(table:unknown)=>({where:()=>({for:async()=>{if(table===savCaseEffectExecutions)return [execution];if(table===savIntakeEffects){effectLocks++;if(mode==="expires-after-effect-lock"&&effectLocks===1)vi.setSystemTime(t+2000);return [effect];}throw Error("SYN_UNEXPECTED_TABLE");}})})}),update:()=>({set:(patch:Record<string,unknown>)=>({where:async()=>{updates++;Object.assign(effect,patch)}})}),insert:()=>({values:async()=>{}})};
 state.db={transaction:async(fn:(tx:unknown)=>unknown)=>fn(tx)};
 if(mode==="expired-before-first")vi.setSystemTime(t+2000);
 const d=createCaseEffectDriver({env:()=>({}),readTicketOwner: async () => "v2" as const, currentPolicyRevision:async()=>"synthetic-policy"});await d.deferEffect!({row:{id:execution.id},token:execution.leaseToken} as never,{...effect} as never,"SYN_ERROR");
 expect(updates).toBe(mode==="valid"?1:0);expect(effect.reconcileAttempts).toBe(mode==="valid"?1:0);
 });
});
