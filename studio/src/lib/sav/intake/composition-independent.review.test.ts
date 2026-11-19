import {describe,it,expect} from "vitest";
import {savIntakeActiveRequestSignal} from "./engine";
describe("Independent final composition edge controls",()=>{
 it.each(["Merci pour votre rappel, mais le problème persiste.","Plus besoin de me rappeler. Pouvez-vous rétablir mon accès ?","Merci pour votre rappel. Merci de me rappeler demain."])("preserves a separate active request: %s",s=>expect(savIntakeActiveRequestSignal(s)).toBe(true));
 it.each(["Merci pour votre rappel, tout fonctionne maintenant.","Plus besoin de me rappeler, mon problème est résolu."])("resolved callback stays inactive: %s",s=>expect(savIntakeActiveRequestSignal(s)).toBe(false));
});
