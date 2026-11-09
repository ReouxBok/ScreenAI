import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { savIntakeModelCalls, savIntakeExecutions, savIntakeEffects, savIntakeExecutionPolicies, staffUsers } from "@/db/schema";
import { readIntakeUncertainties } from "./uncertainty-read";
import { intakeRuntimeHash } from "./runtime-contract";
import { eq } from "drizzle-orm";
let f: Awaited<ReturnType<typeof createSavTestDb>>;
beforeAll(async()=>{f=await createSavTestDb();},120000);afterAll(async()=>{await f?.client.close();});
it("qualifies exact current-message ledgers across all rows, without old-message contamination or writes",async()=>{
 const ids=Array.from({length:5},()=>randomUUID());
 const [staff]=await f.db.insert(staffUsers).values({clerkId:randomUUID(),email:"synthetic@example.invalid",role:"admin",active:true}).returning();
 const [policy]=await f.db.insert(savIntakeExecutionPolicies).values({revision:"synthetic",state:"approved",administratorId:staff.id,policyHash:"synthetic",payloadCiphertext:"unread"}).returning();
 // More than the diagnostic page limit: the uncertain row must not disappear.
 for(let i=0;i<26;i++)await f.db.insert(savIntakeModelCalls).values({messageKey:intakeRuntimeHash(ids[0]),requestHash:String(i),state:i===0?"uncertain":"settled",reservedNanoUsd:1,chargedNanoUsd:1,payloadCiphertext:"never decrypted"});
 for(const id of [ids[1],ids[2]]){
  const [execution]=await f.db.insert(savIntakeExecutions).values({messageId:id,threadId:randomUUID(),runVersion:1,policyId:policy.id,policyHash:"synthetic",payloadCiphertext:"never decrypted"}).returning();
  await f.db.insert(savIntakeEffects).values({executionId:execution.id,businessKey:id,kind:"email_associate",permission:"associate_email",state:"acked",intentHash:"synthetic",intentCiphertext:"never decrypted"});
 }
 await f.db.insert(savIntakeModelCalls).values({messageKey:intakeRuntimeHash(ids[2]),requestHash:"cost",state:"dispatched",reservedNanoUsd:1,chargedNanoUsd:1,payloadCiphertext:"unread"});
 const before=await f.db.select().from(savIntakeEffects);
 const result=await f.db.transaction(tx=>readIntakeUncertainties(tx,ids),{accessMode:"read only",isolationLevel:"repeatable read"});
 expect(result).toEqual({[ids[0]]:"cost",[ids[1]]:"effect",[ids[2]]:"both",[ids[3]]:"unknown",[ids[4]]:"unknown"});
 expect(await f.db.select().from(savIntakeEffects)).toEqual(before);
 await f.db.update(savIntakeEffects).set({state:"confirmed",confirmedAt:new Date()}).where(eq(savIntakeEffects.businessKey,ids[2]));
 expect((await readIntakeUncertainties(f.db,[ids[2]]))[ids[2]]).toBe("cost");
 await expect(readIntakeUncertainties(f.db,Array.from({length:26},()=>randomUUID()))).rejects.toThrow("INTAKE_MONITOR_PAGE_LIMIT");
});
