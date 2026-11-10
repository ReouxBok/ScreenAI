import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../test/sav-db";
import { savIntakeModelCalls, savSyncState, auditLogs } from "@/db/schema";
const state=vi.hoisted(()=>({db:null as unknown}));
vi.mock("@/db",()=>({requireDb:()=>state.db}));
import { assertSavSharedSpend, lockSavSharedSpend, readSavSharedSpend, sharedSpendUsage } from "./shared-spend";
import { reserveCaseV2Spend, settleCaseV2Spend, releaseCaseV2Spend } from "./cases/investigation-v2-spend";
let f:Awaited<ReturnType<typeof createSavTestDb>>;
const now=new Date("2026-11-09T12:00:00Z"), billion=1_000_000_000;
const policy={revision:"synthetic-v1",approvedBy:"20000000-0000-4000-8000-000000000004",approvedAt:"2026-11-01T00:00:00Z",
 model:{dailyCapMicroUsd:20_000_000,reserveMicroUsdPerCall:1_000_000,microUsdPerMillionInputTokens:1_000_000,microUsdPerMillionOutputTokens:1_000_000},
 embedding:{dailyCapMicroUsd:20_000_000,reserveMicroUsdPerCall:1_000_000,microUsdPerMillionInputTokens:1_000_000}};
const deps={env:()=>({SAV_V2_SPEND_POLICY_JSON:JSON.stringify(policy)}),now:()=>now};
beforeAll(async()=>{f=await createSavTestDb();state.db=f.db;});
afterAll(async()=>{await f.client.close();});
beforeEach(async()=>{await f.db.delete(savIntakeModelCalls);await f.db.delete(savSyncState);await f.db.delete(auditLogs);});
async function intake(cost:number,at=now,status="settled") {
 await f.db.insert(savIntakeModelCalls).values({messageKey:randomUUID(),requestHash:randomUUID(),state:status,reservedNanoUsd:cost,chargedNanoUsd:cost,payloadCiphertext:"synthetic",createdAt:at});
}
it("counts exact UTC day and rolling30 boundaries, retaining old uncertain exposure",()=>{
 const day=new Date("2026-11-09T00:00:00Z"),edge=new Date(now.getTime()-30*86400000);
 expect(sharedSpendUsage([{at:day,nanoUsd:1,uncertain:false},{at:new Date(day.getTime()-1),nanoUsd:2,uncertain:false},
 {at:edge,nanoUsd:4,uncertain:false},{at:new Date(edge.getTime()-1),nanoUsd:8,uncertain:false},{at:new Date("2026-01-01"),nanoUsd:16,uncertain:true}],now))
 .toEqual({dailyNanoUsd:1,rollingNanoUsd:23});
});
it("serializes V1 and V2 reservations at the shared daily cap",async()=>{
 await intake(19*billion);
 const v1=()=>f.db.transaction(async tx=>{await lockSavSharedSpend(tx);await assertSavSharedSpend(tx,billion,now);await tx.insert(savIntakeModelCalls).values({messageKey:randomUUID(),requestHash:randomUUID(),state:"dispatched",reservedNanoUsd:billion,chargedNanoUsd:billion,payloadCiphertext:"synthetic",createdAt:now});return "v1";});
 const results=await Promise.allSettled([v1(),reserveCaseV2Spend(deps,"model","parallel-v2")]);
 const admitted=results.filter(r=>r.status==="fulfilled"&&(r.value==="v1" || typeof r.value==="object"&&r.value.status==="allowed"));
 expect(admitted).toHaveLength(1);expect(await readSavSharedSpend(f.db,now)).toMatchObject({dailyNanoUsd:20*billion});
});
it("counts embedding and model together, and idempotence does not reserve twice",async()=>{
 await intake(18*billion);const first=await reserveCaseV2Spend(deps,"model","same");expect(first.status).toBe("allowed");
 expect(await reserveCaseV2Spend(deps,"model","same")).toEqual(first);
 expect((await reserveCaseV2Spend(deps,"embedding","embed")).status).toBe("allowed");
 expect((await reserveCaseV2Spend(deps,"model","over")).status).toBe("refused");
 expect((await readSavSharedSpend(f.db,now)).dailyNanoUsd).toBe(20*billion);
});
it("enforces rolling90 across V1 and V2 and never forgets uncertain older calls",async()=>{
 await intake(89*billion,new Date("2026-09-01"),"uncertain");
 expect((await reserveCaseV2Spend(deps,"model","ninety")).status).toBe("allowed");
 expect((await reserveCaseV2Spend(deps,"embedding","over")).status).toBe("refused");
 expect((await readSavSharedSpend(f.db,now)).rollingNanoUsd).toBe(90*billion);
});
it("known usage settles once; uncertain usage remains rolling after30 days; release only before send",async()=>{
 const a=await reserveCaseV2Spend(deps,"model","known"),b=await reserveCaseV2Spend(deps,"embedding","unknown");
 if(a.status!=="allowed"||b.status!=="allowed")throw Error("fixture");
 await settleCaseV2Spend(deps,{reservationId:a.reservationId,usage:{inputTokens:100,outputTokens:100},uncertain:false});
 expect(await settleCaseV2Spend(deps,{reservationId:a.reservationId,usage:{inputTokens:0,outputTokens:0},uncertain:false})).toMatchObject({settled:false});
 await settleCaseV2Spend(deps,{reservationId:b.reservationId,usage:"unknown",uncertain:true});
 expect(await releaseCaseV2Spend({reservationId:b.reservationId})).toEqual({released:false});
 expect(await readSavSharedSpend(f.db,new Date("2026-12-11T12:00:00Z"))).toEqual({dailyNanoUsd:0,rollingNanoUsd:billion});
});
it("includes derived and evaluation receipts once without copying them",async()=>{
 for(const action of ["sav_derived_call_reserved","sav_intake_evaluation_call_v1"])
 await f.db.insert(auditLogs).values({actorEmail:"synthetic",action,entityType:"synthetic",entityId:randomUUID(),technicalMetadata:{reservedNanoUsd:billion},createdAt:now});
 expect(await readSavSharedSpend(f.db,now)).toEqual({dailyNanoUsd:2*billion,rollingNanoUsd:2*billion});
});
it("invalid canonical amounts fail closed before a V2 reservation",async()=>{
 await f.db.insert(savSyncState).values({key:"sav-v2-spend.v1:model:2026-11-08",cursor:JSON.stringify({purpose:"model",day:"2026-11-08",settledMicroUsd:100,open:{},done:{}})});
 expect(await reserveCaseV2Spend(deps,"model","invalid")).toMatchObject({status:"refused",reason:"SAV_SHARED_SPEND_HISTORY_INVALID"});
});

it("the same key cannot buy another call after midnight or policy rotation",async()=>{
 const first=await reserveCaseV2Spend(deps,"model","durable");expect(first.status).toBe("allowed");
 const next={env:()=>({SAV_V2_SPEND_POLICY_JSON:JSON.stringify({...policy,revision:"rotated"})}),now:()=>new Date("2026-11-10T12:00:00Z")};
 expect(await reserveCaseV2Spend(next,"model","durable")).toMatchObject({status:"refused",reason:"v2_spend_call_previously_reserved"});
 expect((await readSavSharedSpend(f.db,next.now())).rollingNanoUsd).toBe(billion);
});

it("charges an observed overrun without clamping it and stops later V2 calls",async()=>{
 const held=await reserveCaseV2Spend(deps,"model","overrun");if(held.status!=="allowed")throw Error("fixture");
 await settleCaseV2Spend(deps,{reservationId:held.reservationId,usage:{inputTokens:2_000_000,outputTokens:0},uncertain:false});
 expect((await readSavSharedSpend(f.db,now)).dailyNanoUsd).toBe(2*billion);
 expect(await reserveCaseV2Spend(deps,"model","next")).toMatchObject({status:"refused",reason:"v2_spend_reservation_bound_exceeded"});
});
