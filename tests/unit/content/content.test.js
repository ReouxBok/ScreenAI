// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installChromeMock, uninstallChromeMock } from '../../helpers/chrome-mock.js';
import { loadSidebarScript } from '../../helpers/load-script.js';

describe('content.js — DOM helpers', () => {
  let content;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    // jsdom doesn't implement scrollIntoView — stub it
    if (!HTMLElement.prototype.scrollIntoView) {
      HTMLElement.prototype.scrollIntoView = () => {};
    }
    installChromeMock();
    content = loadSidebarScript('src/content/content.js');
  });

  afterEach(() => {
    uninstallChromeMock();
    vi.restoreAllMocks();
  });

  describe('extractPageContent', () => {
    it('collects visible heading/nav text and dedupes', () => {
      document.title = 'Limova - Accueil';
      document.body.innerHTML = `
        <nav><a href="#">Home</a><a href="#">Settings</a><a href="#">Home</a></nav>
        <h1>Welcome to Limova</h1>
        <h2>Get started</h2>
        <button>Continue</button>
      `;
      const result = content.extractPageContent();
      expect(result.title).toBe('Limova - Accueil');
      expect(result.visibleElements).toContain('Home');
      expect(result.visibleElements).toContain('Welcome to Limova');
      expect(result.visibleElements).toContain('Continue');
      // dedupe
      expect(result.visibleElements.filter(t => t === 'Home')).toHaveLength(1);
    });

    it('caps visibleElements at 60 and activeElements at 10', () => {
      document.body.innerHTML =
        Array.from({ length: 100 }, (_, i) => `<button>btn ${i}</button>`).join('') +
        Array.from({ length: 20 }, (_, i) => `<a aria-selected="true">active ${i}</a>`).join('');
      const result = content.extractPageContent();
      expect(result.visibleElements.length).toBeLessThanOrEqual(60);
      expect(result.activeElements.length).toBeLessThanOrEqual(10);
    });

    it('ignores empty, too-long, and too-short texts', () => {
      document.body.innerHTML = `
        <button></button>
        <button>A</button>
        <button>${'x'.repeat(500)}</button>
        <button>OK</button>
      `;
      const result = content.extractPageContent();
      expect(result.visibleElements).toEqual(['OK']);
    });

    it('exposes only the foreground dialog when the page is covered by a modal', () => {
      document.body.innerHTML = `
        <main><h1>Page derrière</h1><button>Tester l’agent</button></main>
        <section role="dialog" aria-modal="true">
          <h2>Connecter l’agent à mon site internet</h2>
          <button>Copier</button>
        </section>
      `;
      const dialog = document.querySelector('[role="dialog"]');
      dialog.getBoundingClientRect = () => ({ left: 100, top: 40, right: 900, bottom: 700, width: 800, height: 660 });

      const result = content.extractPageContent();

      expect(result.visibleElements).toContain('Connecter l’agent à mon site internet');
      expect(result.visibleElements).toContain('Copier');
      expect(result.visibleElements).not.toContain('Page derrière');
      expect(result.visibleElements).not.toContain('Tester l’agent');
    });
  });

  describe('training fingerprints', () => {
    it('redacts identifiers and describes a control without recording field values', () => {
      document.body.innerHTML = `
        <main><article class="integration-card"><h2>HubSpot</h2>
          <button id="connectHubspot" data-testid="connect-hubspot" aria-label="Connecter HubSpot">Connecter</button>
        </article></main>`;
      const target = document.querySelector('button');
      expect(content.trainingSafeText('alice@example.com +33601020304')).toBe('[email] [phone]');
      expect(content.trainingZone(target)).toBe('main');
      expect(content.trainingSection(target)).toBe('HubSpot');
      expect(content.trainingOccurrence(target, 'Connecter HubSpot')).toBe(1);
      expect(content.safeElementIdentifier(target.dataset.testid)).toBe('connect-hubspot');
    });
  });

  describe('continuous assistant observation', () => {
    it('describes a user field change without copying its value', () => {
      document.body.innerHTML = '<label for="message">Message</label><textarea id="message">contenu privé</textarea>';
      const payload = content.assistantInteractionPayload('input', document.querySelector('textarea'));
      expect(payload).toMatchObject({ kind: 'input', label: 'Message', controlType: 'contrôle cliquable', filled: true });
      expect(JSON.stringify(payload)).not.toContain('contenu privé');
    });
  });

  describe('checkForErrors', () => {
    it('returns false when there are no error nodes', () => {
      document.body.innerHTML = '<div>all good</div>';
      expect(content.checkForErrors()).toBe(false);
    });

    it('returns true when a [role=alert] is present', () => {
      document.body.innerHTML = '<div role="alert">Oops</div>';
      expect(content.checkForErrors()).toBe(true);
    });

    it('returns true when any error class is present', () => {
      document.body.innerHTML = '<div class="alert-danger">Boom</div>';
      expect(content.checkForErrors()).toBe(true);
    });
  });

  describe('isLikelyModal', () => {
    it('detects role=dialog', () => {
      const el = document.createElement('div');
      el.setAttribute('role', 'dialog');
      expect(content.isLikelyModal(el)).toBe(true);
    });

    it('detects role=alertdialog', () => {
      const el = document.createElement('div');
      el.setAttribute('role', 'alertdialog');
      expect(content.isLikelyModal(el)).toBe(true);
    });

    it('detects aria-modal=true', () => {
      const el = document.createElement('div');
      el.setAttribute('aria-modal', 'true');
      expect(content.isLikelyModal(el)).toBe(true);
    });

    it('detects <dialog open>', () => {
      const el = document.createElement('dialog');
      el.setAttribute('open', '');
      expect(content.isLikelyModal(el)).toBe(true);
    });

    it('returns false for non-HTMLElement inputs', () => {
      expect(content.isLikelyModal(null)).toBe(false);
      expect(content.isLikelyModal(document.createTextNode('x'))).toBe(false);
    });

    it('returns false for a plain div without modal signals', () => {
      const el = document.createElement('div');
      el.textContent = 'hello';
      document.body.appendChild(el);
      expect(content.isLikelyModal(el)).toBe(false);
    });
  });

  describe('findElementByText', () => {
    it('finds an exact text match', () => {
      document.body.innerHTML = '<button>Continue</button><button>Cancel</button>';
      const found = content.findElementByText('Continue');
      expect(found.tagName).toBe('BUTTON');
      expect(found.textContent).toBe('Continue');
    });

    it('prefers the exact match over a containing match', () => {
      document.body.innerHTML = `
        <button>Save changes now</button>
        <button>Save</button>
      `;
      const found = content.findElementByText('Save');
      expect(found.textContent).toBe('Save');
    });

    it('returns null when no element matches', () => {
      document.body.innerHTML = '<div>unrelated</div>';
      expect(content.findElementByText('absolutely missing')).toBeNull();
    });

    it('matches aria-label when available', () => {
      document.body.innerHTML = '<button aria-label="Send message"></button>';
      const found = content.findElementByText('Send message');
      expect(found).not.toBeNull();
    });
  });

  describe('getElementByLid', () => {
    it('selects via data-lid', () => {
      document.body.innerHTML = '<button data-lid="l-42">Click</button>';
      expect(content.getElementByLid('l-42').textContent).toBe('Click');
    });

    it('returns null when no matching lid exists', () => {
      expect(content.getElementByLid('missing')).toBeNull();
    });
  });

  describe('silent visual capture metadata', () => {
    it('returns mask and target geometry without changing the visible DOM or copying values', () => {
      document.documentElement.dataset.limovaContextVersion = '6';
      document.body.innerHTML = `
        <input data-lid="1" value="alice@example.com">
        <button data-lid="2" aria-label="Envoyer le message"></button>
      `;
      for (const element of document.querySelectorAll('[data-lid]')) {
        element.getBoundingClientRect = () => ({ left: 20, top: 30, right: 220, bottom: 70, width: 200, height: 40 });
      }

      const capture = content.prepareVisualCapture(6);
      expect(capture).toMatchObject({ ok: true, maskedCount: 1, markerCount: 2, viewportWidth: expect.any(Number), viewportHeight: expect.any(Number) });
      expect(capture.masks).toEqual([expect.objectContaining({ left: 20, top: 30, width: 200, height: 40 })]);
      expect(capture.markers.map(marker => marker.id)).toEqual([1, 2]);
      expect(JSON.stringify(capture)).not.toContain('alice@example.com');
      expect(document.querySelector('#limova-visual-capture-overlays')).toBeNull();
    });

    it('refuses to annotate a stale DOM map', () => {
      document.documentElement.dataset.limovaContextVersion = '8';
      expect(content.prepareVisualCapture(7)).toMatchObject({ ok: false });
    });
  });

  describe('executeElementAction', () => {
    it('clicks only a current, visible element identified by data-lid', () => {
      document.documentElement.dataset.limovaContextVersion = '7';
      document.body.innerHTML = '<button data-lid="4">Open</button>';
      const button = document.querySelector('button');
      button.getBoundingClientRect = () => ({ width: 80, height: 32 });
      const click = vi.spyOn(button, 'click');
      expect(content.executeElementAction(4, 7)).toEqual({ ok: true });
      expect(click).toHaveBeenCalledOnce();
    });

    it('refuses stale page context and non-actionable inputs', () => {
      document.documentElement.dataset.limovaContextVersion = '9';
      document.body.innerHTML = '<input data-lid="2" value="private">';
      expect(content.executeElementAction(2, 8).ok).toBe(false);
      expect(content.executeElementAction(2, 9).ok).toBe(false);
    });

    it('clicks a keyboard-accessible Limova integration tile', () => {
      document.documentElement.dataset.limovaContextVersion = '10';
      document.body.innerHTML = '<div tabindex="0" data-lid="6"><span>Connecter Gmail</span></div>';
      const tile = document.querySelector('[tabindex="0"]');
      tile.getBoundingClientRect = () => ({ width: 300, height: 180 });
      const click = vi.spyOn(tile, 'click');

      expect(content.executeElementAction(6, 10)).toEqual({ ok: true });
      expect(click).toHaveBeenCalledOnce();
    });

    it('clicks a visually actionable control even when the app omitted its button role', () => {
      document.documentElement.dataset.limovaContextVersion = '10';
      document.body.innerHTML = '<div class="cursor-pointer" data-testid="connect-gmail" data-lid="7"><span>Gmail</span></div>';
      const control = document.querySelector('.cursor-pointer');
      control.getBoundingClientRect = () => ({ width: 220, height: 48 });
      const click = vi.spyOn(control, 'click');

      expect(content.executeElementAction(7, 10)).toEqual({ ok: true });
      expect(click).toHaveBeenCalledOnce();
    });

    it('refuses a stale target behind the active modal and allows the foreground control', () => {
      document.documentElement.dataset.limovaContextVersion = '10';
      document.body.innerHTML = `
        <button data-lid="7">Tester l’agent</button>
        <section role="dialog" aria-modal="true"><button data-lid="8">Copier</button></section>
      `;
      for (const element of document.querySelectorAll('[data-lid], [role="dialog"]')) {
        element.getBoundingClientRect = () => ({ left: 20, top: 20, right: 220, bottom: 70, width: 200, height: 50 });
      }
      const backgroundClick = vi.spyOn(document.querySelector('[data-lid="7"]'), 'click');
      const modalClick = vi.spyOn(document.querySelector('[data-lid="8"]'), 'click');

      expect(content.executeElementAction(7, 10)).toMatchObject({ ok: false, status: 'unexpected' });
      expect(content.executeElementAction(8, 10)).toEqual({ ok: true });
      expect(backgroundClick).not.toHaveBeenCalled();
      expect(modalClick).toHaveBeenCalledOnce();
    });

    it('shows a computer-use pointer before clicking', async () => {
      vi.useFakeTimers();
      window.requestAnimationFrame = callback => setTimeout(callback, 0);
      document.documentElement.dataset.limovaContextVersion = '11';
      document.body.innerHTML = '<button data-lid="5">Intégrations</button>';
      const button = document.querySelector('button');
      button.getBoundingClientRect = () => ({ left: 100, top: 80, width: 120, height: 40 });
      const click = vi.spyOn(button, 'click');

      const action = content.executeElementActionWithCursor(5, 11);
      await vi.advanceTimersByTimeAsync(250);
      expect(document.querySelector('#limova-computer-use-pointer')).toBeTruthy();
      expect(click).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(700);

      await expect(action).resolves.toMatchObject({ ok: true, visualized: true });
      expect(click).toHaveBeenCalledOnce();
      vi.useRealTimers();
    });

    it('dispatches pointer and mouse activation before the single click', async () => {
      vi.useFakeTimers();
      window.requestAnimationFrame = callback => setTimeout(callback, 0);
      document.documentElement.dataset.limovaContextVersion = '12';
      document.body.innerHTML = '<button data-lid="8"><span>Préférences</span></button>';
      const button = document.querySelector('button');
      button.getBoundingClientRect = () => ({ left: 20, top: 20, width: 160, height: 44 });
      const events = [];
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        button.addEventListener(type, () => events.push(type));
      }

      const action = content.executeElementActionWithCursor(8, 12);
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(action).resolves.toMatchObject({
        ok: true,
        interactionMode: 'pointer-mouse-click'
      });
      expect(events).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
      vi.useRealTimers();
    });
  });

  describe('executePageScroll', () => {
    it('scrolls the main visible container without coordinates', async () => {
      vi.useFakeTimers();
      document.documentElement.dataset.limovaContextVersion = '23';
      document.body.innerHTML = '<main style="overflow-y:auto"><button data-lid="1">Suite</button></main>';
      const main = document.querySelector('main');
      Object.defineProperty(main, 'clientHeight', { configurable: true, value: 500 });
      Object.defineProperty(main, 'scrollHeight', { configurable: true, value: 1800 });
      Object.defineProperty(main, 'scrollTop', { configurable: true, writable: true, value: 0 });
      main.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 500 });
      main.scrollTo = vi.fn(({ top }) => { main.scrollTop = top; });

      const scrolling = content.executePageScroll({ direction: 'down', amount: 'medium', contextVersion: 23 });
      await vi.advanceTimersByTimeAsync(450);
      await expect(scrolling).resolves.toMatchObject({ ok: true, moved: true, atStart: false });
      expect(main.scrollTo).toHaveBeenCalledWith({ top: 310, behavior: 'smooth' });
      vi.useRealTimers();
    });
  });

  describe('setElementText', () => {
    it('fills the current non-sensitive field and emits framework-compatible events', () => {
      document.documentElement.dataset.limovaContextVersion = '12';
      document.body.innerHTML = '<textarea data-lid="6" aria-label="Instructions"></textarea>';
      const field = document.querySelector('textarea');
      field.getBoundingClientRect = () => ({ left: 20, top: 30, width: 240, height: 80 });
      const input = vi.fn();
      const change = vi.fn();
      field.addEventListener('input', input);
      field.addEventListener('change', change);

      expect(content.setElementText(6, 12, 'Prépare un résumé concis')).toEqual({ ok: true });
      expect(field.value).toBe('Prépare un résumé concis');
      expect(input).toHaveBeenCalledOnce();
      expect(change).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(field);
    });

    it('rejects stale, sensitive and oversized text fields', () => {
      document.documentElement.dataset.limovaContextVersion = '13';
      document.body.innerHTML = `
        <input data-lid="7" type="password">
        <input data-lid="8" maxlength="4">
      `;
      for (const field of document.querySelectorAll('input')) {
        field.getBoundingClientRect = () => ({ left: 10, top: 10, width: 100, height: 30 });
      }

      expect(content.setElementText(7, 13, 'secret').ok).toBe(false);
      expect(content.setElementText(8, 12, 'test').ok).toBe(false);
      expect(content.setElementText(8, 13, 'trop long').ok).toBe(false);
      expect(document.querySelector('[data-lid="7"]').value).toBe('');
      expect(document.querySelector('[data-lid="8"]').value).toBe('');
    });

    it('shows the computer-use pointer before filling', async () => {
      vi.useFakeTimers();
      window.requestAnimationFrame = callback => setTimeout(callback, 0);
      document.documentElement.dataset.limovaContextVersion = '14';
      document.body.innerHTML = '<input data-lid="9" aria-label="Nom du projet">';
      const field = document.querySelector('input');
      field.getBoundingClientRect = () => ({ left: 80, top: 60, width: 220, height: 40 });

      const action = content.executeElementTextInputWithCursor(9, 14, 'Projet Atlas');
      await vi.advanceTimersByTimeAsync(250);
      expect(document.querySelector('#limova-computer-use-pointer')).toBeTruthy();
      expect(field.value).toBe('');
      await vi.advanceTimersByTimeAsync(800);

      await expect(action).resolves.toMatchObject({ ok: true, visualized: true, inputVerified: true });
      expect(field.value).toBe('Projet Atlas');
      vi.useRealTimers();
    });

    it('scrolls an offscreen field into view before validating and filling it', async () => {
      vi.useFakeTimers();
      window.requestAnimationFrame = callback => setTimeout(callback, 0);
      document.documentElement.dataset.limovaContextVersion = '15';
      document.body.innerHTML = '<textarea data-lid="10" aria-label="Instructions"></textarea><div id="cover"></div>';
      const field = document.querySelector('textarea');
      let top = -220;
      field.getBoundingClientRect = () => ({ left: 80, right: 300, top, bottom: top + 40, width: 220, height: 40 });
      field.scrollIntoView = vi.fn(() => { top = 60; });
      document.elementFromPoint = vi.fn(() => top < 0 ? document.querySelector('#cover') : field);

      const action = content.executeElementTextInputWithCursor(10, 15, 'Projet Atlas');
      await vi.advanceTimersByTimeAsync(1_100);

      await expect(action).resolves.toMatchObject({ ok: true, visualized: true, inputVerified: true });
      expect(field.scrollIntoView).toHaveBeenCalledOnce();
      expect(field.value).toBe('Projet Atlas');
      delete document.elementFromPoint;
      vi.useRealTimers();
    });
  });

  describe('highlightElement', () => {
    it('injects an overlay positioned over the target', () => {
      const target = document.createElement('button');
      target.textContent = 'Click me';
      document.body.appendChild(target);
      target.getBoundingClientRect = () => ({ left: 40, top: 20, width: 120, height: 32 });
      expect(content.highlightElement(target)).toBe(true);
      const overlays = document.querySelectorAll('.limova-element-highlight');
      expect(overlays.length).toBe(1);
      expect(overlays[0].style.left).toBe('37px');
      expect(overlays[0].style.width).toBe('126px');
    });

    it('injects the keyframes stylesheet once', () => {
      const a = document.createElement('button');
      const b = document.createElement('button');
      document.body.append(a, b);
      a.getBoundingClientRect = () => ({ left: 1, top: 1, width: 80, height: 30 });
      b.getBoundingClientRect = () => ({ left: 1, top: 1, width: 80, height: 30 });
      content.highlightElement(a);
      content.highlightElement(b);
      expect(document.querySelectorAll('#limova-highlight-styles').length).toBe(1);
    });

    it('frames the exact input instead of its wide integration row', () => {
      document.documentElement.dataset.limovaContextVersion = '20';
      document.body.innerHTML = `
        <div class="integration-item" data-lid="1">
          <input aria-label="Rechercher des intégrations">
          <span>3237 apps disponibles</span>
        </div>
      `;
      const row = document.querySelector('.integration-item');
      const input = document.querySelector('input');
      row.getBoundingClientRect = () => ({ left: 15, top: 75, width: 1180, height: 56 });
      input.getBoundingClientRect = () => ({ left: 25, top: 85, width: 385, height: 40 });

      expect(content.resolveHighlightTarget(row)).toBe(row);
      expect(content.resolveHighlightTarget(input)).toBe(input);
      // The extraction ID is attached to the exact interactive target in production.
      row.removeAttribute('data-lid');
      input.dataset.lid = '1';
      expect(content.highlightElementById(1, 20)).toEqual({ ok: true });

      const overlay = document.querySelector('.limova-element-highlight');
      expect(overlay.style.left).toBe('22px');
      expect(overlay.style.width).toBe('391px');
    });

    it('refuses a highlight produced from a stale DOM version', () => {
      document.documentElement.dataset.limovaContextVersion = '22';
      document.body.innerHTML = '<input data-lid="3">';
      expect(content.highlightElementById(3, 21)).toMatchObject({ ok: false });
      expect(document.querySelector('.limova-element-highlight')).toBeNull();
    });
  });
});
