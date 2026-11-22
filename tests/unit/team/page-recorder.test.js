// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pageSnapshot } from '../../../src/team/page-snapshot.js';
import { pausePageRecorder, startPageRecorder, stopPageRecorder } from '../../../src/team/page-recorder.js';
import { installLayout, resetIsolatedWorld } from './helpers.js';

const PAGE = `
  <nav><a href="/home?x=1" id="nav-home">Accueil</a></nav>
  <main>
    <h2>Nouvelle facture</h2>
    <form id="invoice" name="nouvelle-facture" action="/invoices" method="post">
      <label for="client">Client</label>
      <input id="client" name="customer" placeholder="Rechercher un client" data-testid="customer-input">
      <label for="amount">Montant HT</label><input id="amount" name="amount" type="number">
      <label for="pw">Mot de passe</label><input id="pw" type="password" name="password">
      <label for="otp">Code reçu par SMS</label><input id="otp" autocomplete="one-time-code">
      <label for="vat">TVA</label>
      <select id="vat"><option value="0">0 %</option><option value="20">20 %</option></select>
      <label><input type="checkbox" id="cgv"> J’accepte</label>
      <input type="file" id="file" aria-label="Pièce jointe">
      <button type="submit" id=":r1f:">Enregistrer</button>
    </form>
    <table><tr><td>ACME SAS</td><td><button>Modifier</button></td></tr><tr><td>Globex</td><td><button>Modifier</button></td></tr></table>
    <a href="/exports/factures.csv?sig=abc">Exporter</a>
    <div id="empty">Zone vide</div>
    <div role="status" id="status"></div>
  </main>`;

function fire(el, type, init = {}) {
  const Ctor = type === 'keydown' ? KeyboardEvent : type === 'click' ? MouseEvent : type === 'focusout' ? FocusEvent : Event;
  el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, ...init }));
}

function type(el, value) {
  for (let index = 1; index <= value.length; index += 1) {
    el.value = value.slice(0, index);
    fire(el, 'input');
  }
}

describe('page recorder (isolated world)', () => {
  let restoreLayout;
  let sent;
  beforeEach(() => {
    resetIsolatedWorld();
    globalThis.__limovaRecorder?.uninstall?.();
    globalThis.__limovaRecorder = null;
    history.replaceState(null, '', '/invoices/new?token=secret');
    document.title = 'Factures';
    document.body.innerHTML = PAGE;
    restoreLayout = installLayout();
    sent = [];
    globalThis.chrome = { runtime: { sendMessage: vi.fn(async message => { sent.push(message); return { ok: true, recording: true }; }) } };
    expect(pageSnapshot({ installOnly: true }).ok).toBe(true);
    expect(startPageRecorder({ recordingId: 'rec-1', acceptUntrusted: true }).ok).toBe(true);
  });
  afterEach(() => {
    stopPageRecorder({ flush: false });
    restoreLayout();
    resetIsolatedWorld();
    delete globalThis.chrome;
  });

  const events = () => sent.filter(message => message.type === 'TEAM_RECORD_EVENT').map(message => message.event);

  it('records one fill per field, with the final value, on blur', () => {
    const client = document.getElementById('client');
    type(client, 'ACME SAS');
    expect(events()).toEqual([]);
    fire(client, 'focusout');
    const fills = events().filter(event => event.kind === 'fill');
    expect(fills).toHaveLength(1);
    expect(fills[0].value).toBe('ACME SAS');
    expect(fills[0].page).toEqual({ url: 'http://localhost:3000/invoices/new', title: 'Factures' });
    expect(fills[0].target).toEqual(expect.objectContaining({
      role: 'textbox', name: 'Client', tag: 'input', label: 'Client', placeholder: 'Rechercher un client',
      nearby: 'Nouvelle facture',
      hints: expect.objectContaining({ input_type: 'text', input_name: 'customer', testid: 'customer-input', id_attr: 'client', landmark: 'main' }),
      form: expect.objectContaining({ name: 'nouvelle-facture', method: 'post' })
    }));
    // Focus out again without typing: nothing new.
    fire(client, 'focusout');
    expect(events().filter(event => event.kind === 'fill')).toHaveLength(1);
  });

  it('never lets a secret field’s value leave the page', () => {
    const pw = document.getElementById('pw');
    type(pw, 'hunter2');
    fire(pw, 'focusout');
    const otp = document.getElementById('otp');
    type(otp, '482913');
    fire(otp, 'focusout');
    const [password, code] = events();
    expect(password).toEqual(expect.objectContaining({ kind: 'fill', value_withheld: true, secret_kind: 'password', sensitive: true }));
    expect(code).toEqual(expect.objectContaining({ value_withheld: true, secret_kind: 'otp' }));
    expect(JSON.stringify(sent)).not.toMatch(/hunter2|482913/);
  });

  it('records select labels, checks, uploads (names only) and downloads', () => {
    const vat = document.getElementById('vat');
    vat.value = '20';
    fire(vat, 'change');
    const cgv = document.getElementById('cgv');
    cgv.checked = true;
    fire(cgv, 'change');
    const file = document.getElementById('file');
    Object.defineProperty(file, 'files', { value: [{ name: 'facture.pdf', type: 'application/pdf', size: 1200 }] });
    fire(file, 'change');
    fire(document.querySelector('a[href^="/exports"]'), 'click');
    const [select, check, upload, download] = events();
    expect(select).toEqual(expect.objectContaining({ kind: 'select', option: '20 %' }));
    expect(select.target).toEqual(expect.objectContaining({ role: 'combobox', label: 'TVA' }));
    expect(check).toEqual(expect.objectContaining({ kind: 'check', checked: true }));
    expect(check.target.name).toBe('J’accepte');
    expect(upload).toEqual(expect.objectContaining({ kind: 'upload', files: [{ name: 'facture.pdf', mime: 'application/pdf', size: 1200 }] }));
    expect(download).toEqual(expect.objectContaining({ kind: 'download', file: { name: 'factures.csv' } }));
    expect(download.target.hints.href_path).toBe('http://localhost:3000/exports/factures.csv');
  });

  it('describes clicks the way a person finds them again, never with a selector', () => {
    const [, second] = document.querySelectorAll('table button');
    fire(second, 'click');
    fire(document.querySelector('button[type="submit"]'), 'click');
    const [edit, save] = events().filter(event => event.kind === 'click');
    expect(edit.target).toEqual(expect.objectContaining({ role: 'button', name: 'Modifier', nearby: 'Globex', ordinal: 1 }));
    // A generated id (`:r1f:`) is not a hint.
    expect(save.target.hints?.id_attr).toBeUndefined();
    expect(save.target.hints.input_name).toBeUndefined();
    expect(JSON.stringify(events())).not.toMatch(/selector|xpath|"x":|"y":|nth-child|#client/);
  });

  it('ignores clicks on empty space and events the page fires itself', () => {
    fire(document.getElementById('empty'), 'click');
    expect(events()).toEqual([]);
    stopPageRecorder({ flush: false });
    startPageRecorder({ recordingId: 'rec-2' });
    fire(document.querySelector('button[type="submit"]'), 'click');
    expect(events()).toEqual([]);
  });

  it('records Enter after flushing the field, Escape and Tab; never typing keys', () => {
    const client = document.getElementById('client');
    type(client, 'Globex');
    fire(client, 'keydown', { key: 'g' });
    fire(client, 'keydown', { key: 'Enter' });
    fire(client, 'keydown', { key: 'Escape' });
    fire(client, 'keydown', { key: 'Tab' });
    expect(events().map(event => [event.kind, event.key || event.value])).toEqual([['fill', 'Globex'], ['key', 'Enter'], ['key', 'Escape'], ['key', 'Tab']]);
  });

  it('records keys for their effect, never typing or caret moves inside a field (TEAM-751)', async () => {
    document.body.insertAdjacentHTML('beforeend', `
      <label for="city">Ville</label><input id="city" role="combobox" aria-autocomplete="list" aria-expanded="true">
      <span id="chip" role="button" tabindex="0">Paris ×</span>
      <div id="grid" tabindex="0" role="grid" aria-label="Tableau">cellules</div>
      <label for="notes">Notes</label><textarea id="notes"></textarea>
      <div id="composer" contenteditable="true" aria-label="Message"></div>`);
    const client = document.getElementById('client');
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Backspace', 'Delete', ' ', 'ArrowDown', 'PageDown']) fire(client, 'keydown', { key });
    expect(events()).toEqual([]);
    // In a combobox, ArrowDown picks an option.
    fire(document.getElementById('city'), 'keydown', { key: 'ArrowDown' });
    // Backspace deletes a chip; arrows move in a grid.
    fire(document.getElementById('chip'), 'keydown', { key: 'Backspace' });
    fire(document.getElementById('grid'), 'keydown', { key: 'ArrowRight' });
    // Keys that click or choose are recorded as that click or choice.
    fire(document.querySelector('button[type="submit"]'), 'keydown', { key: ' ' });
    fire(document.getElementById('vat'), 'keydown', { key: 'ArrowDown' });
    // Shortcuts never count.
    fire(document.getElementById('city'), 'keydown', { key: 'Enter', ctrlKey: true });
    expect(events().map(event => [event.key, event.target?.name])).toEqual([
      ['ArrowDown', 'Ville'], ['Backspace', 'Paris ×'], ['ArrowRight', 'Tableau']
    ]);

    // On the page itself, only a key the page took (a plain scroll is noise).
    sent.length = 0;
    fire(document.body, 'keydown', { key: 'PageDown' });
    document.addEventListener('keydown', event => event.preventDefault(), { once: true });
    fire(document.body, 'keydown', { key: 'ArrowDown' });
    // Enter in a text area is a new line; in a composer that cancels it, a « send ».
    fire(document.getElementById('notes'), 'keydown', { key: 'Enter' });
    document.addEventListener('keydown', event => event.preventDefault(), { once: true });
    fire(document.getElementById('composer'), 'keydown', { key: 'Enter' });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(events().map(event => [event.key, event.target?.name ?? null])).toEqual([['ArrowDown', null], ['Enter', 'Message']]);
  });

  it('records a file chosen in a hidden input under its label, names only (TEAM-751)', () => {
    document.body.insertAdjacentHTML('beforeend', '<label for="proof">Justificatif</label><input id="proof" type="file" style="display:none">');
    const input = document.getElementById('proof');
    Object.defineProperty(input, 'files', { configurable: true, value: [{ name: 'facture.pdf', type: 'application/pdf', size: 1200 }] });
    fire(input, 'change');
    expect(events()).toEqual([expect.objectContaining({
      kind: 'upload',
      target: expect.objectContaining({ name: 'Justificatif', hints: expect.objectContaining({ input_type: 'file' }) }),
      files: [{ name: 'facture.pdf', mime: 'application/pdf', size: 1200 }]
    })]);
  });

  it('flushes fields typed before a pause, then records nothing while paused', () => {
    const client = document.getElementById('client');
    type(client, 'ACME');
    const paused = pausePageRecorder({ recordingId: 'rec-1', paused: true });
    expect(paused.events.map(event => event.value)).toEqual(['ACME']);
    type(client, 'ACME 2');
    fire(client, 'focusout');
    fire(document.querySelector('button[type="submit"]'), 'click');
    expect(events()).toEqual([]);
    pausePageRecorder({ recordingId: 'rec-1', paused: false });
    fire(document.querySelector('button[type="submit"]'), 'click');
    expect(events().map(event => event.kind)).toEqual(['click']);
  });

  it('hands back the field being typed at « Arrêter », then stops listening', () => {
    type(document.getElementById('amount'), '1200');
    const stopped = stopPageRecorder({ recordingId: 'rec-1' });
    expect(stopped.events).toEqual([expect.objectContaining({ kind: 'fill', value: '1200' })]);
    fire(document.querySelector('button[type="submit"]'), 'click');
    expect(events()).toEqual([]);
    expect(globalThis.__limovaRecorder).toBeNull();
  });

  it('reports what changed after an action, 600 ms to 3 s later', async () => {
    fire(document.querySelector('button[type="submit"]'), 'click');
    document.getElementById('status').textContent = 'Facture créée';
    await new Promise(resolve => setTimeout(resolve, 1300));
    const observed = sent.find(message => message.type === 'TEAM_RECORD_OBSERVED')?.observed;
    expect(observed).toEqual(expect.objectContaining({ seq: 1, dom_changed: true, messages: ['Facture créée'], url: 'http://localhost:3000/invoices/new' }));
  });

  it('never changes the page', () => {
    const before = document.body.innerHTML;
    type(document.getElementById('client'), 'x');
    fire(document.getElementById('client'), 'focusout');
    expect(document.body.innerHTML.replace(/value="[^"]*"/g, '')).toBe(before.replace(/value="[^"]*"/g, ''));
    expect(document.querySelector('[data-limova], [data-lid]')).toBeNull();
  });
});

describe('read_page descriptor fields (browser.record.v1)', () => {
  let restoreLayout;
  beforeEach(() => {
    resetIsolatedWorld();
    history.replaceState(null, '', '/invoices/new');
    document.body.innerHTML = PAGE;
    document.getElementById('client').value = 'valeur-tapee-123';
    restoreLayout = installLayout();
  });
  afterEach(() => {
    restoreLayout();
    resetIsolatedWorld();
  });

  it('adds label, placeholder, nearby and hints, never a value', () => {
    const result = pageSnapshot({ productKey: 'limova_team', snapshotId: 's1' });
    const client = result.elements.find(element => element.name === 'Client');
    expect(client).toEqual(expect.objectContaining({
      label: 'Client', placeholder: 'Rechercher un client', nearby: 'Nouvelle facture',
      hints: expect.objectContaining({ input_name: 'customer', testid: 'customer-input', id_attr: 'client' })
    }));
    expect(JSON.stringify(result.elements)).not.toContain('valeur-tapee-123');
    const home = result.elements.find(element => element.name === 'Accueil');
    expect(home.hints).toEqual(expect.objectContaining({ href_path: 'http://localhost:3000/home', landmark: 'navigation', id_attr: 'nav-home' }));
  });
});
