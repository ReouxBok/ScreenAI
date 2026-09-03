"use server";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireDb } from "@/db";
import { contentItems, testCases } from "@/db/schema";
import { requireApiStaff } from "@/lib/auth";
import { searchKnowledge } from "@/lib/search";

async function runOne(id:string) {
  const db=requireDb(); const [test]=await db.select().from(testCases).where(eq(testCases.id,id)).limit(1); if(!test) return;
  try { const result=await searchKnowledge({query:test.query,path:test.path??"",locale:test.locale,contentTypes:["article","onboarding"],limit:3}); const rank=result.results.findIndex(item=>item.id===test.expectedItemId); await db.update(testCases).set({lastStatus:rank>=0?"passed":"failed",lastResult:{rank:rank>=0?rank+1:null,resultIds:result.results.map(item=>item.id)},lastRunAt:new Date()}).where(eq(testCases.id,id)); }
  catch(error){await db.update(testCases).set({lastStatus:"error",lastResult:{rank:null,resultIds:[],error:error instanceof Error?error.message:"Erreur"},lastRunAt:new Date()}).where(eq(testCases.id,id));}
}
export async function runQualityTestAction(form:FormData){await requireApiStaff();await runOne(String(form.get("testId")));revalidatePath("/studio/tests");}
export async function runAllQualityTestsAction(){await requireApiStaff();const tests=await requireDb().select({id:testCases.id}).from(testCases).where(eq(testCases.enabled,true));for(const test of tests)await runOne(test.id);revalidatePath("/studio/tests");}
export async function createQualityTestAction(form:FormData){await requireApiStaff();const query=String(form.get("query")??"").trim();const expectedItemId=String(form.get("expectedItemId")??"");const path=String(form.get("path")??"").trim();if(query.length<5)throw new Error("QUESTION_TOO_SHORT");const [item]=await requireDb().select({id:contentItems.id}).from(contentItems).where(eq(contentItems.id,expectedItemId)).limit(1);if(!item)throw new Error("EXPECTED_CONTENT_NOT_FOUND");await requireDb().insert(testCases).values({query,path:path||null,expectedItemId,locale:"fr-FR"});revalidatePath("/studio/tests");}
