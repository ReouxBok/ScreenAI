import { describe, it, expect } from 'vitest';
import {
  buildRecording, byteSize, cleanTarget, cleanUrl, fitRecording, guessParameter, MAX_RECORDING_BYTES, stepLabel, validateRecording, wireStep, withLegacyKeys } from '../../../src/team/recording-format.js';

const START = Date.parse('2026-11-22T18:00:00Z');
const ID = '6f0a4c1e-6b8e-4d7e-9c55-0d3f2a9b1e11';

function steps(count) {
  return Array.from({ length: count }, (_, index) => ({
    kind: 'click', at: START + index * 10, tab: 1,
    target: { role: 'button', name: `Bouton ${index}` },
    page: { url: 'https://app.example.com/a?token=1#x', title: 'A' }
  }));
}

describe('limova.recording.v1 format', () => {
  it('builds the wire recording with origin+path URLs, ordered ids and times', () => {
    const recording = buildRecording({
      recordingId: ID,
      title: '  Créer une facture client  ',
      startedAt: START,
      endedAt: START + 161_000,
      appVersion: '2.2.63',
      locale: 'fr-FR',
      steps: [
        { kind: 'navigate', at: START, tab: 1, url: 'https://app.pennylane.com/invoices?x=1', cause: 'typed', tabId: 812, key: 'k1' },
        { kind: 'click', at: START + 2400, tab: 1, tabId: 812, target: { role: 'button', name: 'Nouvelle facture', hints: { testid: 'new-invoice', href_path: 'https://a.b/c?d' } }, observed: { url_changed: true, url: 'https://app.pennylane.com/invoices/new?y', messages: ['Code 482913'] } },
        { kind: 'fill', at: START + 6800, tab: 1, target: { role: 'textbox', name: 'Client' }, value: 'ACME SAS', candidate_parameter: true, parameter_name: 'client' },
        { kind: 'fill', at: START + 7000, tab: 1, target: { role: 'textbox', name: 'Mot de passe' }, value: { redacted: 'password' }, sensitive: true, candidate_parameter: true },
        { kind: 'click', at: START + 7100, deleted: true, target: { name: 'Erreur' } },
        { kind: 'click', at: START + 7200, target: {} }
      ]
    });
    expect(recording.schema).toBe('limova.recording.v1');
    expect(recording.title).toBe('Créer une facture client');
    expect(recording.session).toEqual({
      started_at: '2026-11-22T18:00:00.000Z',
      ended_at: '2026-11-22T18:02:41.000Z',
      origins: ['https://app.pennylane.com'],
      recorder: { surface: 'chrome_extension', app_version: '2.2.63' },
      locale: 'fr-FR'
    });
    expect(recording.steps.map(step => [step.id, step.t, step.kind])).toEqual([
      ['s1', 0, 'navigate'], ['s2', 2400, 'click'], ['s3', 6800, 'fill'], ['s4', 7000, 'fill']
    ]);
    expect(recording.steps[0]).toEqual({ id: 's1', t: 0, kind: 'navigate', tab: 1, url: 'https://app.pennylane.com/invoices', cause: 'typed' });
    expect(recording.steps[1].target.hints).toEqual({ testid: 'new-invoice', href_path: 'https://a.b/c' });
    expect(recording.steps[1].observed).toEqual({ url_changed: true, url: 'https://app.pennylane.com/invoices/new', messages: ['Code [masqué]'] });
    expect(recording.steps[2]).toEqual(expect.objectContaining({ value: 'ACME SAS', candidate_parameter: true, parameter_name: 'client' }));
    // A redacted value is never a parameter, and always sensitive.
    expect(recording.steps[3]).toEqual(expect.objectContaining({ value: { redacted: 'password' }, sensitive: true }));
    expect(recording.steps[3].candidate_parameter).toBeUndefined();
    expect(JSON.stringify(recording)).not.toMatch(/"tabId"|"key"|"deleted"|token=|\?/);
    expect(validateRecording(recording)).toEqual([]);
  });

  it('never sends a selector, coordinates or a DOM index in a target', () => {
    const target = cleanTarget({ role: 'button', name: 'OK', selector: '#a > b', xpath: '/html/body', x: 10, y: 20, index: 3, ordinal: 2 });
    expect(target).toEqual({ role: 'button', name: 'OK', ordinal: 2 });
  });

  it('cuts every field to the server limits', () => {
    const long = 'x'.repeat(1000);
    const target = cleanTarget({ role: long, name: long, tag: long, text: long, label: long, placeholder: long, nearby: long, hints: { input_type: long, input_name: long, autocomplete: long, testid: long, id_attr: long, landmark: long }, form: { name: long, action_origin: long, method: 'post' }, ordinal: 9999 });
    expect(target.role).toHaveLength(40);
    expect(target.name).toHaveLength(200);
    expect(target.tag).toHaveLength(20);
    expect(target.nearby).toHaveLength(300);
    expect(target.hints.input_type).toHaveLength(30);
    expect(target.hints.autocomplete).toHaveLength(60);
    expect(target.hints.testid).toHaveLength(100);
    expect(target.form.name).toHaveLength(100);
    expect(target.ordinal).toBe(500);
    const fill = wireStep({ kind: 'fill', target: { name: 'A' }, value: long.repeat(6) }, { id: 's1', t: 0 });
    expect(fill.value).toHaveLength(5000);
    expect(cleanUrl('javascript:alert(1)')).toBeNull();
    expect(wireStep({ kind: 'navigate', url: 'chrome://newtab' }, { id: 's1', t: 0 })).toBeNull();
    expect(wireStep({ kind: 'teleport' }, { id: 's1', t: 0 })).toBeNull();
    expect(wireStep({ kind: 'key', key: 'a' }, { id: 's1', t: 0 })).toBeNull();
  });

  it('checks the limits: 1 to 300 steps, 2 hours, 512 KB, ordered times, unique ids', () => {
    const ok = buildRecording({ recordingId: ID, startedAt: START, endedAt: START + 1000, steps: steps(300) });
    expect(validateRecording(ok)).toEqual([]);
    expect(validateRecording({ ...ok, steps: [] })).toContain('steps');
    expect(validateRecording({ ...ok, steps: [...ok.steps, { ...ok.steps[0], id: 's999' }] })).toContain('steps');
    expect(validateRecording({ ...ok, session: { ...ok.session, ended_at: '2026-11-22T20:00:01Z' } })).toContain('session.ended_at');
    expect(validateRecording({ ...ok, recording_id: 'nope' })).toContain('recording_id');
    const shuffled = { ...ok, steps: [ok.steps[1], ok.steps[0]] };
    expect(validateRecording(shuffled)).toContain('steps.1.t');
    expect(validateRecording({ ...ok, steps: [ok.steps[0], { ...ok.steps[1], id: 's1' }] })).toContain('steps.1.id');
    expect(validateRecording({ ...ok, steps: [{ id: 's1', t: 0, kind: 'click', target: { role: 'button' } }] })).toContain('steps.0.target');
    const huge = buildRecording({ recordingId: ID, startedAt: START, endedAt: START + 1000, steps: steps(300).map(step => ({ ...step, target: { ...step.target, nearby: 'n'.repeat(300), text: 't'.repeat(200), label: 'l'.repeat(200), placeholder: 'p'.repeat(200) }, observed: { messages: Array(5).fill('m'.repeat(200)) } })) });
    expect(byteSize(huge)).toBeGreaterThan(MAX_RECORDING_BYTES);
    expect(validateRecording(huge)).toContain('size');
  });

  it('builds a recording from the format doc’s example steps that validates', () => {
    const build = buildRecording({
      recordingId: ID, startedAt: START, endedAt: START + 15000,
      steps: [
        { kind: 'select', at: START + 9200, target: { role: 'combobox', name: 'TVA', label: 'TVA' }, option: '20 %' },
        { kind: 'check', at: START + 9300, target: { role: 'checkbox', name: 'J’accepte' }, checked: true },
        { kind: 'key', at: START + 9400, key: 'Enter', target: { role: 'textbox', name: 'Recherche' } },
        { kind: 'upload', at: START + 9500, target: { role: 'button', name: 'Pièce jointe' }, files: [{ name: 'facture.pdf', mime: 'application/pdf', size: 1200 }] },
        { kind: 'download', at: START + 9600, target: { role: 'link', name: 'Exporter' }, file: { name: 'export.csv' } },
        { kind: 'wait', at: START + 15000, ms: 1500, observed: { messages: ['Facture créée'] } }
      ]
    });
    expect(validateRecording(build)).toEqual([]);
    expect(build.steps.map(step => step.kind)).toEqual(['select', 'check', 'key', 'upload', 'download', 'wait']);
    expect(build.steps[3].files).toEqual([{ name: 'facture.pdf', mime: 'application/pdf', size: 1200 }]);
  });

  it('fits a large recording under 512 KB: narration first, then steps from the end', () => {
    const narration = Array.from({ length: 200 }, (_, index) => ({ start_ms: index, end_ms: index + 1, text: 'n'.repeat(100) }));
    const bulky = steps(300).map(step => ({ ...step, target: { ...step.target, nearby: 'n'.repeat(300), text: 't'.repeat(200), label: 'l'.repeat(200), placeholder: 'p'.repeat(200) }, observed: { messages: Array(5).fill('m'.repeat(200)) } }));
    const recording = buildRecording({ recordingId: ID, startedAt: START, endedAt: START + 5000, steps: bulky, narration });
    expect(recording.narration).toHaveLength(200);
    const { recording: fitted, cut } = fitRecording(recording);
    expect(byteSize(fitted)).toBeLessThanOrEqual(MAX_RECORDING_BYTES);
    expect(cut.narration).toBe(200);
    expect(cut.steps).toBeGreaterThan(0);
    expect(fitted.narration).toBeUndefined();
    expect(fitted.steps[0].id).toBe('s1');
    expect(validateRecording(fitted)).toEqual([]);
    // Narration alone can make room.
    const light = buildRecording({ recordingId: ID, startedAt: START, endedAt: START + 5000, steps: steps(2), narration });
    const { cut: lightCut } = fitRecording(light, byteSize(light) - 500);
    expect(lightCut.narration).toBeGreaterThan(0);
    expect(lightCut.steps).toBe(0);
  });

  it('pre-guesses values that change: names, amounts, dates, e-mails', () => {
    expect(guessParameter({ kind: 'fill', target: { label: 'E-mail', hints: { input_type: 'email' } }, value: 'camille@example.com' })).toEqual({ candidate: true, name: 'e_mail' });
    expect(guessParameter({ kind: 'fill', target: { label: 'Montant HT' }, value: '1200' })).toEqual({ candidate: true, name: 'montant_ht' });
    expect(guessParameter({ kind: 'fill', target: { label: 'Échéance', hints: { input_type: 'date' } }, value: '2026-12-01' })).toEqual({ candidate: true, name: 'echeance' });
    expect(guessParameter({ kind: 'fill', target: { label: 'Client' }, value: 'ACME SAS' })).toEqual({ candidate: true, name: 'client' });
    expect(guessParameter({ kind: 'fill', target: { label: 'Commentaire' }, value: 'RAS' })).toEqual({ candidate: false });
    expect(guessParameter({ kind: 'fill', target: { label: 'Mot de passe' }, value: { redacted: 'password' } })).toEqual({ candidate: false });
  });

  it('labels steps in French for the step list', () => {
    expect(stepLabel({ kind: 'navigate', url: 'https://app.example.com/invoices', cause: 'typed' })).toBe('Ouverture de app.example.com/invoices');
    expect(stepLabel({ kind: 'click', target: { name: 'Envoyer' } })).toBe('Clic sur « Envoyer »');
    expect(stepLabel({ kind: 'fill', target: { label: 'Client' } })).toBe('Saisie dans « Client »');
    expect(stepLabel({ kind: 'check', checked: false, target: { name: 'Newsletter' } })).toBe('Décoche « Newsletter »');
    expect(stepLabel({ kind: 'key', key: 'Enter' })).toBe('Touche Entrée');
    expect(stepLabel({ kind: 'wait', ms: 2400 })).toBe('Attente de 2 s');
  });

  it('takes every key of browser.press_key in a key step, and a child frame in a target (TEAM-751)', () => {
    const at = 1_800_000_000_000;
    const recording = buildRecording({
      recordingId: '6f0a4c1e-6b8e-4d7e-9c55-0d3f2a9b1e11', startedAt: at, endedAt: at + 5000, appVersion: '2.2.63', locale: 'fr-FR',
      steps: [
        { kind: 'key', key: 'ArrowDown', at: at + 100, target: { role: 'combobox', name: 'Ville', frame: { origin: 'https://js.stripe.com', name: 'Carte', path: [1, 0] } } },
        { kind: 'key', key: 'Enter', at: at + 200 },
        { kind: 'key', key: 'F5', at: at + 300 },
        { kind: 'key', key: 'Space', at: at + 400, target: { role: 'option', name: 'Lyon' } },
        { kind: 'fill', value: 'x', at: at + 500, target: { name: 'Nom', frame: { origin: 'javascript:alert(1)', path: [0, 1, 2, 3, 4, 5] } } }
      ]
    });
    expect(recording.steps.map(step => step.key || step.kind)).toEqual(['ArrowDown', 'Enter', 'Space', 'fill']);
    expect(recording.steps[0].target.frame).toEqual({ origin: 'https://js.stripe.com', name: 'Carte', path: [1, 0] });
    // A frame reference that is not one is dropped, never sent half-made.
    expect(recording.steps[3].target.frame).toBeUndefined();
    expect(validateRecording(recording)).toEqual([]);
    expect(stepLabel(recording.steps[0])).toBe('Touche Flèche bas dans « Ville »');

    const legacy = withLegacyKeys(recording);
    expect(legacy.dropped).toBe(2);
    expect(legacy.recording.steps.map(step => [step.id, step.key || step.kind])).toEqual([['s1', 'Enter'], ['s2', 'fill']]);
  });
});
