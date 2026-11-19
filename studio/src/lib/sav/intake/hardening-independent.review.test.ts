import { describe,expect,it } from 'vitest';
import { intakeTicketDescription } from './ticket-description';
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
