import { expect, it } from "vitest";
import { savIntakeDeclaredAccount } from "./registration-declaration";
const old = "wrong@account.test", next = "correct@account.test", resource = "calendar@resource.test";
it.each([
 `Mon compte Limova est ${old}. Correction : ${next} est mon compte Limova.`,
 `Mon compte Limova est ${old}. Utilisez plutôt ${next} comme identifiant Limova.`,
 `My Limova account is ${old}. Use ${next} instead as my Limova account email.`,
])("REVIEW_R6 rejects the explicitly superseded identity: %s", text => {
 expect(savIntakeDeclaredAccount(text, old, {continuation:false})).toBe(false);
});
it("REVIEW_R6 preserves the newly explicit account",()=>{
 const text=`Mon compte Limova est ${old}. Correction : ${next} est mon compte Limova.`;
 expect(savIntakeDeclaredAccount(text,next,{continuation:false})).toBe(true);
});
it.each([
 `Mon compte Limova est ${old}. Correction : le calendrier ${resource} doit être connecté.`,
 `My Limova account is ${old}. Correction: calendar ${resource} must be connected.`,
])("REVIEW_R6 unrelated resource correction never retracts identity or adopts resource: %s",text=>{
 expect(savIntakeDeclaredAccount(text,old,{continuation:false})).toBe(true);
 expect(savIntakeDeclaredAccount(text,resource,{continuation:false})).toBe(false);
});
