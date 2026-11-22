import http from 'node:http';
import { test, expect } from './fixtures.js';

// TEAM-751: keys, file uploads and iframes, run by the real engine in Chromium. One local
// server answers on two origins (127.0.0.1 and localhost), so a frame from the other one
// is a real cross-origin frame. No Limova Team server is contacted.

const KEYS_PAGE = `<!doctype html><html><head><title>Clavier</title></head><body>
  <form id="search" action="/results" method="get">
    <label for="q">Recherche</label><input id="q" name="q">
    <button type="submit">Rechercher</button>
  </form>
  <label for="first">Prénom</label><input id="first">
  <label for="last">Nom</label><input id="last">
  <button id="menuButton" aria-haspopup="menu" onclick="document.getElementById('menu').hidden = false">Menu</button>
  <div id="menu" role="menu" hidden><div role="menuitem" tabindex="-1">Profil</div></div>
  <label for="country">Pays</label>
  <select id="country"><option>France</option><option disabled>Belgique</option><option>Suisse</option></select>
  <label for="pw">Mot de passe</label><input id="pw" type="password" value="hunter2">
  <label for="note">Note</label><input id="note" value="abcd">
  <div role="status" id="log"></div>
  <script>
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') document.getElementById('menu').hidden = true;
      window.__keys = (window.__keys || []).concat([event.key + ':' + event.keyCode]);
    });
    document.getElementById('country').addEventListener('change', event => {
      document.getElementById('log').textContent = 'Pays : ' + event.target.value;
    });
  </script>
</body></html>`;

const UPLOAD_PAGE = `<!doctype html><html><head><title>Justificatifs</title></head><body>
  <label for="proof" style="display:inline-block;padding:8px;border:1px solid">Justificatif</label>
  <input id="proof" type="file" accept=".pdf,image/*" style="display:none">
  <button id="pick" type="button" onclick="document.getElementById('photos').click()">Ajouter des photos</button>
  <input id="photos" type="file" accept="image/*" multiple style="position:absolute;opacity:0;width:1px;height:1px">
  <div id="zone" role="button" tabindex="0" style="width:200px;height:80px;border:1px dashed">Déposez vos fichiers ici</div>
  <div role="status" id="out"></div>
  <script>
    const out = document.getElementById('out');
    for (const id of ['proof', 'photos']) {
      document.getElementById(id).addEventListener('change', event => {
        out.textContent = id + ' : ' + [...event.target.files].map(file => file.name + ' (' + file.size + ')').join(', ');
      });
    }
    const zone = document.getElementById('zone');
    zone.addEventListener('dragover', event => event.preventDefault());
    zone.addEventListener('drop', event => {
      event.preventDefault();
      out.textContent = 'Déposé : ' + [...event.dataTransfer.files].map(file => file.name).join(', ');
    });
  </script>
</body></html>`;

const framesPage = crossOrigin => `<!doctype html><html><head><title>Paiement</title></head><body>
  <h1>Paiement</h1>
  <iframe src="/inner" title="Adresse" style="width:400px;height:160px"></iframe>
  <iframe src="${crossOrigin}/card" title="Carte bancaire" style="width:400px;height:160px"></iframe>
  <iframe src="/inner" style="display:none"></iframe>
</body></html>`;

const INNER = `<!doctype html><html><head><title>Adresse</title></head><body>
  <label for="city">Ville</label><input id="city">
  <button onclick="document.getElementById('s').textContent = 'Adresse validée'">Valider</button>
  <div role="status" id="s"></div>
</body></html>`;

const CARD = `<!doctype html><html><head><title>Carte</title></head><body>
  <p>Saisissez votre carte</p>
  <label for="cc">Numéro de carte</label><input id="cc" autocomplete="cc-number">
  <button onclick="location.href = '/card-done'">Continuer</button>
</body></html>`;

let server;
let SITE;
let OTHER;
test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const route = request.url.split('?')[0];
    if (route === '/keys') return response.end(KEYS_PAGE);
    if (route === '/results') return response.end('<!doctype html><title>Résultats</title><p>Résultats</p>');
    if (route === '/upload') return response.end(UPLOAD_PAGE);
    if (route === '/frames') return response.end(framesPage(OTHER));
    if (route === '/inner') return response.end(INNER);
    if (route === '/card') return response.end(CARD);
    if (route === '/card-done') return response.end('<!doctype html><title>OK</title><p>Carte enregistrée</p>');
    return response.end('<!doctype html><title>?</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  SITE = `http://127.0.0.1:${server.address().port}`;
  OTHER = `http://localhost:${server.address().port}`;
});
test.afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

// The engine runs in an extension page, like the service worker would run it.
async function engineHost(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/team/approval.html?id=none`);
  await page.evaluate(async () => {
    const { createBrowserEngine } = await import(chrome.runtime.getURL('src/team/browser-engine.js'));
    const { PRODUCTS } = await import(chrome.runtime.getURL('src/team/products.js'));
    globalThis.teamBrowser = createBrowserEngine({}).forProduct(PRODUCTS.limova_team);
    // One action, checked then run, as the controller does.
    globalThis.act = async (tool, args) => {
      const prepared = await globalThis.teamBrowser.prepareAction(tool, args);
      if (prepared.error) return prepared.error;
      return globalThis.teamBrowser.executeAction(prepared.plan);
    };
  });
  return page;
}

async function openAndRead(host, url) {
  return host.evaluate(async target => {
    const opened = await globalThis.teamBrowser.openTab({ url: target, active: true });
    const tabId = opened.data.tab.tab_id;
    const read = await globalThis.teamBrowser.readPage({ tab_id: tabId });
    return { tabId, read };
  }, url);
}

const idOf = (read, name) => read.data.elements.find(element => element.name === name)?.id;

test.describe('Limova Team: keys, uploads and frames (TEAM-751)', () => {
  test('presses keys with the browser default actions: Tab, Enter, Escape, arrows, Backspace', async ({ context, extensionId }) => {
    const host = await engineHost(context, extensionId);
    const { tabId, read } = await openAndRead(host, `${SITE}/keys`);
    expect(read.error).toBeUndefined();
    const site = context.pages().find(page => page.url().startsWith(`${SITE}/keys`));
    const snapshot = read.data.snapshot_id;

    const results = await host.evaluate(async ({ tabId, snapshot, ids }) => {
      const out = {};
      // Tab from « Prénom » goes to « Nom »; Shift+Tab comes back.
      out.tab = await act('browser.press_key', { tab_id: tabId, key: 'Tab', snapshot_id: snapshot, element_id: ids.first, target: 'Prénom' });
      out.shiftTab = await act('browser.press_key', { tab_id: tabId, key: 'Tab', shift: true });
      // Escape closes a menu the page opened (its keydown handler sees the key).
      await act('browser.click', { tab_id: tabId, snapshot_id: snapshot, element_id: ids.menu, target: 'Menu' });
      out.escape = await act('browser.press_key', { tab_id: tabId, key: 'Escape' });
      // ArrowDown in a select skips the disabled option and fires change.
      out.arrow = await act('browser.press_key', { tab_id: tabId, key: 'ArrowDown', snapshot_id: snapshot, element_id: ids.country, target: 'Pays' });
      // Backspace edits a plain field, never a password field.
      out.backspace = await act('browser.press_key', { tab_id: tabId, key: 'Backspace', snapshot_id: snapshot, element_id: ids.note, target: 'Note' });
      out.sensitive = await act('browser.press_key', { tab_id: tabId, key: 'Backspace', snapshot_id: snapshot, element_id: ids.pw, target: 'Mot de passe' });
      // Enter and Space must name their element.
      out.enterAlone = await act('browser.press_key', { tab_id: tabId, key: 'Enter' });
      out.unknown = await act('browser.press_key', { tab_id: tabId, key: 'a' });
      return out;
    }, {
      tabId, snapshot,
      ids: { first: idOf(read, 'Prénom'), menu: idOf(read, 'Menu'), country: idOf(read, 'Pays'), note: idOf(read, 'Note'), pw: idOf(read, 'Mot de passe') }
    });
    expect(results.tab.ok).toBe(true);
    expect(results.tab.data.focused).toEqual({ role: 'textbox', name: 'Nom' });
    expect(results.shiftTab.data.focused).toEqual({ role: 'textbox', name: 'Prénom' });
    expect(results.escape.ok).toBe(true);
    expect(await site.locator('#menu').isHidden()).toBe(true);
    expect(results.arrow.ok).toBe(true);
    expect(await site.locator('#country').inputValue()).toBe('Suisse');
    expect(results.arrow.data.verification.messages).toContain('Pays : Suisse');
    expect(await site.locator('#note').inputValue()).toBe('abc');
    expect(results.sensitive.error.code).toBe('sensitive_field');
    expect(await site.locator('#pw').inputValue()).toBe('hunter2');
    expect(results.enterAlone.error.code).toBe('invalid_args');
    expect(results.unknown.error.code).toBe('invalid_args');
    // The page saw real-looking key events (key and keyCode).
    expect(await site.evaluate(() => window.__keys)).toEqual(expect.arrayContaining(['Tab:9', 'Escape:27', 'ArrowDown:40', 'Backspace:8']));

    // Enter in the search field submits its form; the answer carries the new page.
    const fresh = await host.evaluate(async tabId => globalThis.teamBrowser.readPage({ tab_id: tabId }), tabId);
    const submitted = await host.evaluate(async ({ tabId, snapshot, id }) => act('browser.press_key', {
      tab_id: tabId, key: 'Enter', snapshot_id: snapshot, element_id: id, target: 'Recherche', include_page: true
    }), { tabId, snapshot: fresh.data.snapshot_id, id: idOf(fresh, 'Recherche') });
    expect(submitted.ok).toBe(true);
    expect(submitted.data.verification.url_changed).toBe(true);
    expect(submitted.data.page.tab.url).toBe(`${SITE}/results`);
    await host.close();
  });

  test('lists hidden file inputs and uploads into them, or drops on a drop area', async ({ context, extensionId }) => {
    const host = await engineHost(context, extensionId);
    const { tabId, read } = await openAndRead(host, `${SITE}/upload`);
    const site = context.pages().find(page => page.url().startsWith(`${SITE}/upload`));
    const proof = read.data.elements.find(element => element.name === 'Justificatif');
    expect(proof).toEqual(expect.objectContaining({ role: 'button', tag: 'input', type: 'file', accept: '.pdf,image/*', multiple: false, state: 'empty', files: 0 }));
    const photos = read.data.elements.find(element => element.type === 'file' && element.multiple);
    expect(photos?.name).toBe('Ajouter des photos');
    const snapshot = read.data.snapshot_id;
    const pdf = { source: 'inline', name: 'facture-octobre.pdf', mime: 'application/pdf', size: 5, data: btoa('%PDF-') };
    const txt = { source: 'inline', name: 'notes.txt', mime: 'text/plain', size: 3, data: btoa('abc') };
    const png = { source: 'inline', name: 'photo.png', mime: 'image/png', size: 4, data: btoa('PNG!') };

    const out = await host.evaluate(async ({ tabId, snapshot, ids, files }) => ({
      uploaded: await act('browser.upload', { tab_id: tabId, snapshot_id: snapshot, element_id: ids.proof, target: 'Justificatif', files: [files.pdf] }),
      wrongType: await act('browser.upload', { tab_id: tabId, snapshot_id: snapshot, element_id: ids.proof, target: 'Justificatif', files: [files.txt] }),
      tooMany: await act('browser.upload', { tab_id: tabId, snapshot_id: snapshot, element_id: ids.proof, target: 'Justificatif', files: [files.pdf, files.png] }),
      // The button that opens the hidden input names it too.
      viaButton: await act('browser.upload', { tab_id: tabId, snapshot_id: snapshot, element_id: ids.pick, target: 'Ajouter des photos', files: [files.png, files.png] }),
      dropped: await act('browser.upload', { tab_id: tabId, snapshot_id: snapshot, element_id: ids.zone, target: 'Déposez vos fichiers ici', files: [files.txt] }),
      mac: await act('browser.upload', { tab_id: tabId, snapshot_id: snapshot, element_id: ids.proof, target: 'Justificatif', files: [{ source: 'mac', root: 'r1', path: 'a.pdf' }] }),
      click: await act('browser.click', { tab_id: tabId, snapshot_id: snapshot, element_id: ids.proof, target: 'Justificatif' }),
      reread: await globalThis.teamBrowser.readPage({ tab_id: tabId })
    }), {
      tabId, snapshot,
      ids: { proof: proof.id, pick: read.data.elements.find(element => element.tag === 'button' && element.name === 'Ajouter des photos').id, zone: idOf(read, 'Déposez vos fichiers ici') },
      files: { pdf, txt, png }
    });
    expect(out.uploaded.ok).toBe(true);
    expect(out.uploaded.data.files).toEqual([{ name: 'facture-octobre.pdf', size: 5 }]);
    expect(out.uploaded.data.verification.messages).toContain('proof : facture-octobre.pdf (5)');
    expect(await site.evaluate(() => document.getElementById('proof').files[0].type)).toBe('application/pdf');
    expect(out.wrongType.error.code).toBe('invalid_args');
    expect(out.tooMany.error.code).toBe('invalid_args');
    expect(out.viaButton.ok).toBe(true);
    expect(await site.evaluate(() => document.getElementById('photos').files.length)).toBe(2);
    expect(out.dropped.ok).toBe(true);
    expect(await site.locator('#out').textContent()).toBe('Déposé : notes.txt');
    expect(out.mac.error.code).toBe('unsupported');
    expect(out.click.error.code).toBe('invalid_args');
    // A count, never the names.
    const after = out.reread.data.elements.find(element => element.name === 'Justificatif');
    expect(after).toEqual(expect.objectContaining({ state: 'filled', files: 1 }));
    expect(JSON.stringify(out.reread.data.elements)).not.toContain('facture-octobre');
    await host.close();
  });

  test('reads same-origin and cross-origin frames, acts in them, and catches a frame that navigated', async ({ context, extensionId }) => {
    const host = await engineHost(context, extensionId);
    const { tabId, read } = await openAndRead(host, `${SITE}/frames`);
    expect(read.error).toBeUndefined();
    const data = read.data;
    const port = new URL(SITE).port;
    // Hidden frames are not listed; the two shown ones are, in document order.
    expect(data.frames).toEqual([
      { id: 'fr1', parent: null, origin: SITE, name: 'Adresse', path: [0], cross_origin: false, readable: true, elements: 2 },
      { id: 'fr2', parent: null, origin: OTHER, name: 'Carte bancaire', path: [1], cross_origin: true, readable: true, elements: 2 }
    ]);
    const city = data.elements.find(element => element.name === 'Ville');
    expect(city).toEqual(expect.objectContaining({ id: 'fr1.e1', frame: 'fr1', role: 'textbox' }));
    const card = data.elements.find(element => element.name === 'Numéro de carte');
    expect(card).toEqual(expect.objectContaining({ frame: 'fr2', state: 'sensitive' }));
    expect(data.text).toContain(`[Cadre fr1 · 127.0.0.1:${port}]`);
    expect(data.text).toContain(`[Cadre fr2 · localhost:${port}]`);
    expect(data.text).toContain('Saisissez votre carte');

    const site = context.pages().find(page => page.url().startsWith(`${SITE}/frames`));
    const inner = site.frames().find(frame => frame.url().startsWith(`${SITE}/inner`) && frame.parentFrame() === site.mainFrame());
    // The map stays in each frame's isolated world.
    expect(await inner.evaluate(() => typeof window.__limovaBrowserMaps)).toBe('undefined');

    const out = await host.evaluate(async ({ tabId, snapshot, ids }) => ({
      fill: await act('browser.fill', { tab_id: tabId, snapshot_id: snapshot, element_id: ids.city, target: 'Ville', value: 'Lyon' }),
      click: await act('browser.click', { tab_id: tabId, snapshot_id: snapshot, element_id: ids.valider, target: 'Valider' }),
      card: await act('browser.fill', { tab_id: tabId, snapshot_id: snapshot, element_id: ids.card, target: 'Numéro de carte', value: '4111111111111111' }),
      unknownFrame: await act('browser.click', { tab_id: tabId, snapshot_id: snapshot, element_id: 'fr9.e1', target: 'Valider' }),
      // « Continuer » navigates the card frame: its old ids are stale now.
      navigate: await act('browser.click', { tab_id: tabId, snapshot_id: snapshot, element_id: ids.next, target: 'Continuer' })
    }), {
      tabId, snapshot: data.snapshot_id,
      ids: { city: city.id, valider: idOf(read, 'Valider'), card: card.id, next: idOf(read, 'Continuer') }
    });
    expect(out.fill.ok).toBe(true);
    expect(await inner.locator('#city').inputValue()).toBe('Lyon');
    expect(out.click.ok).toBe(true);
    expect(out.click.data.verification.messages).toContain('Adresse validée');
    expect(out.card.error.code).toBe('sensitive_field');
    expect(out.unknownFrame.error.code).toBe('element_not_found');
    expect(out.navigate.ok).toBe(true);
    await expect.poll(() => site.frames().some(frame => frame.url().endsWith('/card-done'))).toBe(true);
    const stale = await host.evaluate(async ({ tabId, snapshot, id }) => act('browser.fill', {
      tab_id: tabId, snapshot_id: snapshot, element_id: id, target: 'Numéro de carte', value: 'x'
    }), { tabId, snapshot: data.snapshot_id, id: card.id });
    expect(stale.error.code).toBe('stale_snapshot');

    // The screenshot masks the fields of both frames too.
    const shot = await host.evaluate(async tabId => {
      const { createBrowserEngine } = await import(chrome.runtime.getURL('src/team/browser-engine.js'));
      const { PRODUCTS } = await import(chrome.runtime.getURL('src/team/products.js'));
      const seen = [];
      const browser = createBrowserEngine({ renderCapture: async (url, prep) => { seen.push(prep); return { mimeType: 'image/jpeg', data: 'AAAA' }; } }).forProduct(PRODUCTS.limova_team);
      const result = await browser.screenshot({ tab_id: tabId });
      return { ok: result.ok, masked: result.data?.masked, masks: seen[0]?.masks };
    }, tabId);
    expect(shot.ok).toBe(true);
    // « Ville » in fr1; fr2 now shows a page without fields.
    expect(shot.masked).toBeGreaterThanOrEqual(1);
    expect(shot.masks.every(mask => mask.top >= 0 && mask.width > 0)).toBe(true);
    await host.close();
  });
});
