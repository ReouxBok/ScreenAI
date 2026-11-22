// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pageSnapshot } from '../../../src/team/page-snapshot.js';
import { performPageAction } from '../../../src/team/page-actions.js';
import { installLayout, resetIsolatedWorld } from './helpers.js';

// TEAM-751: `browser.press_key` in the page. A script's key event has no default action,
// so the page function performs it, unless the page cancelled the key.

const PAGE = `
  <form id="search" action="/results" method="get">
    <label for="q">Recherche</label><input id="q" name="q" value="chaussures">
    <button type="submit" id="go">Rechercher</button>
  </form>
  <label for="first">Prénom</label><input id="first">
  <label for="skip">Caché</label><input id="skip" tabindex="-1">
  <label for="last">Nom</label><input id="last">
  <label for="early">Premier</label><input id="early" tabindex="1">
  <fieldset><legend>Livraison</legend>
    <label><input type="radio" name="ship" id="r1" checked> Standard</label>
    <label><input type="radio" name="ship" id="r2"> Express</label>
    <label><input type="radio" name="ship" id="r3" disabled> Drone</label>
  </fieldset>
  <label for="country">Pays</label>
  <select id="country"><option>France</option><option disabled>Belgique</option><option>Suisse</option></select>
  <label for="pw">Mot de passe</label><input id="pw" type="password" value="hunter2">
  <label for="note">Note</label><input id="note" value="abcd">
  <label for="msg">Message</label><textarea id="msg">Bonjour</textarea>
  <label><input type="checkbox" id="cgv"> J’accepte</label>
  <button id="trap">Piège</button>
`;

let restoreLayout;
let ids;

function press(key, { name, shift = false } = {}) {
  return performPageAction({
    productKey: 'limova_team', snapshotId: 's1', action: 'key', key, shift,
    elementId: name ? ids[name] : null, expectName: name || undefined
  });
}

beforeEach(() => {
  resetIsolatedWorld();
  document.body.innerHTML = PAGE;
  restoreLayout = installLayout();
  const read = pageSnapshot({ productKey: 'limova_team', snapshotId: 's1' });
  ids = Object.fromEntries(read.elements.map(element => [element.name, element.id]));
});
afterEach(() => {
  restoreLayout();
  resetIsolatedWorld();
});

describe('press_key in the page', () => {
  it('sends keydown and keyup with key, code and keyCode, keypress for Enter and Space', () => {
    const seen = [];
    for (const type of ['keydown', 'keypress', 'keyup']) {
      document.addEventListener(type, event => seen.push(`${type}:${event.key}:${event.code}:${event.keyCode}`));
    }
    press('Escape', { name: 'Note' });
    press('Space', { name: 'J’accepte' });
    expect(seen).toEqual([
      'keydown:Escape:Escape:27', 'keyup:Escape:Escape:27',
      'keydown: :Space:32', 'keypress: :Space:32', 'keyup: :Space:32'
    ]);
  });

  it('moves the focus in tab order: positive tabindex first, one radio per group, tabindex -1 skipped', () => {
    const result = press('Tab', { name: 'Prénom' });
    expect(result).toEqual(expect.objectContaining({ ok: true, focused: { role: 'textbox', name: 'Nom' } }));
    expect(document.activeElement.id).toBe('last');
    expect(press('Tab', { shift: true }).focused.name).toBe('Prénom');
    // From the last tabbable element it wraps to the first, which has tabindex 1.
    document.getElementById('trap').focus();
    expect(press('Tab').focused.name).toBe('Premier');
    document.getElementById('last').focus();
    expect(press('Tab').focused.name).toBe('Standard');
    expect(press('Tab').focused.name).toBe('Pays');
  });

  it('Enter clicks the form’s default button, a button, or types a new line in a text area', () => {
    const clicks = vi.fn(event => event.preventDefault());
    document.getElementById('go').addEventListener('click', clicks);
    expect(press('Enter', { name: 'Recherche' }).ok).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
    const trap = vi.fn();
    document.getElementById('trap').addEventListener('click', trap);
    press('Enter', { name: 'Piège' });
    expect(trap).toHaveBeenCalledTimes(1);
    const msg = document.getElementById('msg');
    msg.setSelectionRange(7, 7);
    const inputs = [];
    msg.addEventListener('input', event => inputs.push(event.inputType));
    press('Enter', { name: 'Message' });
    expect(msg.value).toBe('Bonjour\n');
    expect(inputs).toEqual(['insertLineBreak']);
  });

  it('does nothing of its own when the page cancels the key', () => {
    const clicks = vi.fn(event => event.preventDefault());
    document.getElementById('go').addEventListener('click', clicks);
    document.getElementById('q').addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
    const result = press('Enter', { name: 'Recherche' });
    expect(result.cancelled).toBe(true);
    expect(clicks).not.toHaveBeenCalled();
  });

  it('Space ticks a checkbox and types a space in a field', () => {
    press('Space', { name: 'J’accepte' });
    expect(document.getElementById('cgv').checked).toBe(true);
    const note = document.getElementById('note');
    // An already focused field keeps its caret.
    note.focus();
    note.setSelectionRange(2, 2);
    press('Space', { name: 'Note' });
    expect(note.value).toBe('ab cd');
  });

  it('Backspace and Delete edit a field with an input event, never a sensitive one', () => {
    const note = document.getElementById('note');
    const inputs = [];
    note.addEventListener('input', event => inputs.push(event.inputType));
    note.setSelectionRange(4, 4);
    press('Backspace', { name: 'Note' });
    expect(note.value).toBe('abc');
    note.setSelectionRange(0, 0);
    press('Delete', { name: 'Note' });
    expect(note.value).toBe('bc');
    note.setSelectionRange(0, 2);
    press('Backspace', { name: 'Note' });
    expect(note.value).toBe('');
    expect(inputs).toEqual(['deleteContentBackward', 'deleteContentForward', 'deleteContentBackward']);
    // A field the key focuses itself gets its caret at the end, like a click there.
    const msg = document.getElementById('msg');
    msg.setSelectionRange(0, 0);
    press('Backspace', { name: 'Message' });
    expect(msg.value).toBe('Bonjou');
    for (const key of ['Backspace', 'Delete', 'Space']) {
      expect(press(key, { name: 'Mot de passe' })).toEqual({ ok: false, code: 'sensitive_field' });
    }
    expect(document.getElementById('pw').value).toBe('hunter2');
  });

  it('arrows pick the next enabled option, the next radio, or move the caret', () => {
    const country = document.getElementById('country');
    const changes = vi.fn();
    country.addEventListener('change', changes);
    press('ArrowDown', { name: 'Pays' });
    expect(country.value).toBe('Suisse');
    expect(changes).toHaveBeenCalledTimes(1);
    press('ArrowUp', { name: 'Pays' });
    expect(country.value).toBe('France');
    press('End', { name: 'Pays' });
    expect(country.value).toBe('Suisse');

    press('ArrowDown', { name: 'Standard' });
    expect(document.getElementById('r2').checked).toBe(true);
    // The disabled radio is skipped: the group wraps around.
    press('ArrowDown');
    expect(document.getElementById('r1').checked).toBe(true);

    const note = document.getElementById('note');
    note.setSelectionRange(0, 0);
    press('End', { name: 'Note' });
    expect(note.selectionStart).toBe(4);
    press('ArrowLeft', { name: 'Note', shift: true });
    expect([note.selectionStart, note.selectionEnd]).toEqual([3, 4]);
    press('Home', { name: 'Note' });
    expect([note.selectionStart, note.selectionEnd]).toEqual([0, 0]);
  });

  it('without an element, the key goes to the focused element', () => {
    document.getElementById('first').focus();
    const result = press('Tab');
    expect(result.focused.name).toBe('Nom');
  });

  it('checks the snapshot and the element like any action', () => {
    expect(performPageAction({ productKey: 'limova_team', snapshotId: 's0', action: 'key', key: 'Tab', elementId: ids['Prénom'], expectName: 'Prénom' }).code).toBe('stale_snapshot');
    expect(performPageAction({ productKey: 'limova_team', snapshotId: 's1', action: 'key', key: 'Tab', elementId: ids['Prénom'], expectName: 'Nom' }).code).toBe('stale_snapshot');
    expect(performPageAction({ productKey: 'limova_team', snapshotId: 's1', action: 'key', key: 'F5', elementId: ids['Prénom'], expectName: 'Prénom' }).code).toBe('invalid_args');
  });
});

describe('file inputs in read_page (browser.v2+upload)', () => {
  it('lists a hidden file input under its label or button name, with accept, multiple and a count', () => {
    resetIsolatedWorld();
    document.body.innerHTML = `
      <label for="proof">Justificatif</label><input id="proof" type="file" accept=".pdf,image/*" style="display:none">
      <button type="button" id="pick">Ajouter des photos</button><input id="photos" type="file" multiple style="display:none">
      <div class="dropzone">Glissez vos fichiers ici<input type="file" id="dz" style="display:none"></div>
      <div style="display:none"><input type="file" id="gone"></div>`;
    const read = pageSnapshot({ productKey: 'limova_team', snapshotId: 's2' });
    const files = read.elements.filter(element => element.type === 'file');
    expect(files.map(element => element.name)).toEqual(['Justificatif', 'Ajouter des photos', 'Glissez vos fichiers ici']);
    expect(files[0]).toEqual(expect.objectContaining({ role: 'button', tag: 'input', accept: '.pdf,image/*', multiple: false, state: 'empty', files: 0 }));
    expect(files[1].multiple).toBe(true);
    const kit = globalThis.__limovaBrowserKit;
    // The label and the button both lead to their input.
    expect(kit.fileInputFor(document.querySelector('label[for="proof"]')).id).toBe('proof');
    expect(kit.fileInputFor(document.getElementById('pick')).id).toBe('photos');
    expect(kit.fileInputFor(document.querySelector('.dropzone')).id).toBe('dz');
    expect(kit.uploadTargetOf(document.body).kind).toBe('drop');
    // A drop area next to another field's input is still a drop area.
    document.body.insertAdjacentHTML('beforeend', '<button id="b2">Parcourir</button><input type="file" id="f2" style="display:none"><div id="zone2" role="button">Déposez ici</div>');
    expect(kit.fileInputFor(document.getElementById('b2')).id).toBe('f2');
    expect(kit.fileInputFor(document.getElementById('zone2'))).toBeNull();
  });
});
