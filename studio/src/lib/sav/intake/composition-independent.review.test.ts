import {describe,it,expect} from "vitest";
import {intakePauseIntervals,measureSavIntake} from "./business-measures";
import {savIntakeActiveRequestSignal} from "./engine";
describe("Independent final composition edge controls",()=>{
 it.each(["Merci pour votre rappel, mais le problème persiste.","Plus besoin de me rappeler. Pouvez-vous rétablir mon accès ?","Merci pour votre rappel. Merci de me rappeler demain."])("preserves a separate active request: %s",s=>expect(savIntakeActiveRequestSignal(s)).toBe(true));
 it.each(["Merci pour votre rappel, tout fonctionne maintenant.","Plus besoin de me rappeler, mon problème est résolu."])("resolved callback stays inactive: %s",s=>expect(savIntakeActiveRequestSignal(s)).toBe(false));
 it("does not count a pause-level change as an actual resume",()=>{
 const pauses=intakePauseIntervals([{at:"2026-10-30T09:00:00Z",previousLevel:"running",nextLevel:"fully_paused"},{at:"2026-10-30T09:45:00Z",previousLevel:"fully_paused",nextLevel:"actions_paused"},{at:"2026-10-30T10:00:00Z",previousLevel:"actions_paused",nextLevel:"running"}]);
 const got=measureSavIntake({period:{from:"2026-10-30T00:00:00Z",to:"2026-10-31T00:00:00Z"},pauses,dossiers:[{threadId:"synthetic",messages:[{id:"m",receivedAt:"2026-10-30T09:30:00Z"}],outcome:"operator_catchup",outcomeAt:"2026-10-30T09:50:00Z",confirmedEffects:0}]});
 expect(got.pausedCohort.caughtUpAfterResume).toBe(0);
 });
 it.each([[true,"2026-10-30T10:05:00Z",1],[false,"2026-10-30T09:50:00Z",0]] as const)("level transition control resumed=%s",(resumed,outcomeAt,expected)=>{
 const changes=[{at:"2026-10-30T09:00:00Z",previousLevel:"running",nextLevel:"fully_paused"},{at:"2026-10-30T09:45:00Z",previousLevel:"fully_paused",nextLevel:"actions_paused"},...(resumed?[{at:"2026-10-30T10:00:00Z",previousLevel:"actions_paused",nextLevel:"running"}]:[])];
 const got=measureSavIntake({period:{from:"2026-10-30T00:00:00Z",to:"2026-10-31T00:00:00Z"},pauses:intakePauseIntervals(changes),dossiers:[{threadId:"synthetic-control",messages:[{id:"m",receivedAt:"2026-10-30T09:30:00Z"}],outcome:"operator_catchup",outcomeAt,confirmedEffects:0}]});
 expect(got.pausedCohort.caughtUpAfterResume ?? 0).toBe(expected);
 });
});
