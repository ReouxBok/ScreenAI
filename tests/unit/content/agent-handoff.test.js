// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock, uninstallChromeMock } from '../../helpers/chrome-mock.js';
import { loadSidebarScript } from '../../helpers/load-script.js';

// jsdom has no layout: each element declares its on-screen box as data-rect="left,top,width,height".
function installLayout() {
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const [left, top, width, height] = (this.dataset.rect || '10,10,100,30').split(',').map(Number);
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
  };
  return () => { HTMLElement.prototype.getBoundingClientRect = original; };
}

describe('content.js — Charly presence and Limova handoff', () => {
  let content;
  let restoreLayout;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    HTMLElement.prototype.scrollIntoView ||= () => {};
    restoreLayout = installLayout();
    installChromeMock();
    content = loadSidebarScript('src/content/content.js');
  });

  afterEach(() => {
    content.setAgentPresence(false);
    restoreLayout();
    uninstallChromeMock();
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });

  describe('findChatComposer', () => {
    it('prefers the chat composer over the search field at the top of the page', () => {
      document.body.innerHTML = `
        <input type="search" placeholder="Rechercher" data-rect="10,10,600,30">
        <div data-slot="composer">
          <textarea aria-label="Dis-moi ce que tu as en tête..." enterkeyhint="send" data-rect="200,600,600,40"></textarea>
          <button aria-label="Joindre un fichier" data-rect="810,605,30,30"></button>
          <button aria-label="Envoyer" data-rect="850,605,30,30"></button>
        </div>
      `;

      const composer = content.findChatComposer();

      expect(composer.tagName).toBe('TEXTAREA');
      expect(content.findSendButton(composer).getAttribute('aria-label')).toBe('Envoyer');
    });

    it('still finds the composer and its submit button when the markup changes', () => {
      document.body.innerHTML = `
        <label>Nom <input type="text" name="name" data-rect="20,40,160,28"></label>
        <form>
          <div><textarea placeholder="Écris ton message à Charly" data-rect="180,620,640,44"></textarea></div>
          <button type="button" title="Dictée vocale" data-rect="830,626,30,30"></button>
          <button type="submit" data-rect="870,626,30,30"><svg></svg></button>
        </form>
      `;

      const composer = content.findChatComposer();

      expect(composer.getAttribute('placeholder')).toContain('message');
      expect(content.findSendButton(composer).getAttribute('type')).toBe('submit');
    });

    it('ignores hidden and disabled fields', () => {
      document.body.innerHTML = `
        <textarea aria-label="Message" style="display:none" data-rect="200,600,600,40"></textarea>
        <textarea aria-label="Message" disabled data-rect="200,600,600,40"></textarea>
      `;

      expect(content.findChatComposer()).toBeNull();
    });
  });

  describe('composeAndSendInChat', () => {
    function mountComposer() {
      document.body.innerHTML = `
        <div data-slot="composer">
          <textarea aria-label="Dis-moi ce que tu as en tête..." enterkeyhint="send" data-rect="200,600,600,40"></textarea>
          <button aria-label="Joindre un fichier" data-rect="810,605,30,30"></button>
          <button aria-label="Envoyer" disabled data-rect="850,605,30,30"></button>
        </div>
      `;
      const textarea = document.querySelector('textarea');
      const send = document.querySelector('[aria-label="Envoyer"]');
      const attach = document.querySelector('[aria-label="Joindre un fichier"]');
      const sent = [];
      // Like the Limova composer: send stays disabled until the field has text, then clears it.
      textarea.addEventListener('input', () => { send.disabled = !textarea.value.trim(); });
      send.addEventListener('click', () => {
        sent.push(textarea.value);
        textarea.value = '';
      });
      attach.addEventListener('click', () => sent.push('attach'));
      return { sent };
    }

    it('types the full prompt, waits for the send button and sends it once', async () => {
      const { sent } = mountComposer();
      const prompt = 'Fais-moi un post LinkedIn\n\nContenu de la page :\n"""\nBonjour Limova\n"""';

      const result = await content.composeAndSendInChat('handoff-1', prompt);

      expect(result).toEqual({ ok: true, sent: true, via: 'button' });
      expect(sent).toEqual([prompt]);
      expect(document.getElementById('limova-agent-presence')?.dataset.leaving).toBe('true');
    }, 10_000);

    it('does not send twice when the same handoff is replayed', async () => {
      const { sent } = mountComposer();
      await content.composeAndSendInChat('handoff-2', 'Rédige un mail');

      const replay = await content.composeAndSendInChat('handoff-2', 'Rédige un mail');

      expect(replay.ok).toBe(true);
      expect(sent).toEqual(['Rédige un mail']);
    }, 10_000);

    it('asks the user to sign in instead of typing on the Limova login page', async () => {
      window.history.replaceState(null, '', '/auth?redirectUrl=%2F');
      mountComposer();

      const result = await content.composeAndSendInChat('handoff-3', 'Rédige un mail');

      expect(result).toMatchObject({ ok: false, code: 'not_signed_in' });
    });
  });

  describe('agent presence', () => {
    it('fades the frame in while Charly acts and out when the session stops', async () => {
      content.setAgentPresence(true);
      const host = document.getElementById('limova-agent-presence');
      expect(host).not.toBeNull();

      const [onMessage] = chrome.runtime.onMessage.addListener.mock.calls.at(-1);
      onMessage({ type: 'SESSION_STATE', active: false }, {}, () => {});

      expect(host.style.opacity).toBe('0');
      await new Promise(resolve => setTimeout(resolve, 450));
      expect(document.getElementById('limova-agent-presence')).toBeNull();
    });

    it('keeps the frame when Charly acts again during the fade-out', async () => {
      content.setAgentPresence(true);
      content.setAgentPresence(false);
      content.setAgentPresence(true);
      await new Promise(resolve => setTimeout(resolve, 450));

      expect(document.getElementById('limova-agent-presence')?.style.opacity).toBe('1');
    });
  });

  describe('extractReadableContent', () => {
    it('reads the main content and the user selection, within the size limit', () => {
      document.title = 'LinkedIn';
      document.body.innerHTML = `<nav>Menu</nav><main><p id="post">${'Limova automatise le support. '.repeat(400)}</p></main>`;
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('post'));
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);

      const page = content.extractReadableContent();

      expect(page.title).toBe('LinkedIn');
      expect(page.text.startsWith('Limova automatise le support.')).toBe(true);
      expect(page.text).not.toContain('Menu');
      expect(page.text.length).toBe(6000);
      expect(page.truncated).toBe(true);
      expect(page.selection.length).toBeGreaterThan(0);
    });
  });
});
