import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { savIntakeModelCalls, savIntakeExecutions, savIntakeEffects, savIntakeExecutionPolicies, staffUsers } from "@/db/schema";
import { readIntakeUncertainties, readIntakeUncertaintiesOrUnread } from "./uncertainty-read";
import { intakeUncertaintyLabel } from "./uncertainty";
import { intakeRuntimeHash } from "./runtime-contract";
import { eq, sql } from "drizzle-orm";
import { vi } from "vitest";
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
it("R3: a failed read in a savepoint degrades to unread without aborting the caller's read-only transaction",async()=>{
 const ids=[randomUUID(),randomUUID()];
 const error=vi.spyOn(console,"error").mockImplementation(()=>{});
 const out=await f.db.transaction(async tx=>{
  const result=await readIntakeUncertaintiesOrUnread(ids,read=>tx.transaction(async sp=>{await sp.execute(sql`select 1/0`);return read(sp);}));
  // The outer transaction still answers after the failed savepoint.
  const [after]=await tx.select({n:sql<number>`count(*)::int`}).from(savIntakeEffects);
  const normal=await readIntakeUncertaintiesOrUnread([ids[0]],read=>tx.transaction(read));
  return {result,after,normal};
 },{accessMode:"read only",isolationLevel:"repeatable read"});
 expect(out.result).toEqual({[ids[0]]:"unread",[ids[1]]:"unread"});
 expect(typeof out.after.n).toBe("number");
 expect(out.normal).toEqual({[ids[0]]:"unknown"});
 expect(error).toHaveBeenCalledWith("SAV_INTAKE_UNCERTAINTY_READ_UNAVAILABLE");
 expect(await readIntakeUncertaintiesOrUnread([],async()=>{throw Error("never called");})).toEqual({});
 error.mockRestore();
});
it("R3: the detail's own read-only transaction failing degrades to unread, not to an error",async()=>{
 const id=randomUUID(),error=vi.spyOn(console,"error").mockImplementation(()=>{});
 // Same call shape as console-detail.ts: its own read-only, repeatable-read transaction.
 expect(await readIntakeUncertaintiesOrUnread([id],read=>f.db.transaction(async tx=>{await tx.execute(sql`select 1/0`);return read(tx);},{accessMode:"read only",isolationLevel:"repeatable read"}))).toEqual({[id]:"unread"});
 expect(await readIntakeUncertaintiesOrUnread([id],read=>f.db.transaction(read,{accessMode:"read only",isolationLevel:"repeatable read"}))).toEqual({[id]:"unknown"});
 error.mockRestore();
});
it("R3: the unread label keeps the external-action warning and never claims an absence",()=>{
 const label=intakeUncertaintyLabel("unread");
 expect(label).toContain("HubSpot ou Gmail");expect(label).toContain("renvoi");
 expect(label).not.toMatch(/aucun|absence|sans effet|terminé/i);
});
