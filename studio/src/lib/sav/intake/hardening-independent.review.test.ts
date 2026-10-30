import { describe,expect,it } from 'vitest';
import { intakePauseIntervals,measureSavIntake,type IntakeMeasureDossier } from './business-measures';
import { intakeTicketDescription } from './ticket-description';
const period={from:'2026-10-30T00:00:00.000Z',to:'2026-10-31T00:00:00.000Z'};
const d=(id:string,outcome:IntakeMeasureDossier['outcome'],receivedAt:string,outcomeAt:string):IntakeMeasureDossier=>({threadId:id,outcome,confirmedEffects:0,messages:[{id:id+'-m',receivedAt}],outcomeAt});
const morning=[{at:'2026-10-30T09:00:00.000Z',previousLevel:'running',nextLevel:'fully_paused'},{at:'2026-10-30T10:00:00.000Z',previousLevel:'fully_paused',nextLevel:'running'}];
describe('Independent SAV-77 catch-up outcomes',()=>{
 it('does not call an uncertain external effect caught up',()=>{
  const m=measureSavIntake({period,pauses:intakePauseIntervals(morning),dossiers:[d('u','uncertain_effect','2026-10-30T09:30:00.000Z','2026-10-30T10:05:00.000Z')]});
  expect(m.pausedCohort.outcomes.uncertain_effect).toBe(1);
  expect(m.pausedCohort.caughtUpAfterResume).toBe(0);
 });
 it('retains a confirmed morning catch-up after a second pause/resume',()=>{
  const changes=[...morning,{at:'2026-10-30T14:00:00.000Z',previousLevel:'running',nextLevel:'fully_paused'},{at:'2026-10-30T15:00:00.000Z',previousLevel:'fully_paused',nextLevel:'running'}];
  const m=measureSavIntake({period,pauses:intakePauseIntervals(changes),dossiers:[d('done','autonomous_confirmed','2026-10-30T09:30:00.000Z','2026-10-30T10:05:00.000Z')]});
  expect(m.pausedCohort.caughtUpAfterResume).toBe(1);
 });
 it('keeps the ordinary one-resume confirmed control',()=>{
  expect(measureSavIntake({period,pauses:intakePauseIntervals(morning),dossiers:[d('ok','autonomous_confirmed','2026-10-30T09:30:00.000Z','2026-10-30T10:05:00.000Z')]}).pausedCohort.caughtUpAfterResume).toBe(1);
 });
});
describe('Independent SAV-72 original description controls',()=>{
 it('does not retain quoted old request on a complete HTML document',()=>{
  const got=intakeTicketDescription({subject:'Return',text:'<html><body><p>Le symptôme persiste.</p><div class="gmail_quote">Ancienne demande</div></body></html>'});
  expect(got).toContain('Le symptôme persiste.');expect(got).not.toContain('Ancienne demande');
 });
 it('preserves a literal URL and accents in original text',()=>{
  const got=intakeTicketDescription({subject:'Pièce jointe',text:'Bonjour,\nÉchec sur https://example.invalid/a?x=1&y=2\nMerci.'});
  expect(got).toContain('Échec sur https://example.invalid/a?x=1&y=2');
 });
});
