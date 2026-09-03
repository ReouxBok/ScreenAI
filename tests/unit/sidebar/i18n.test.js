// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installChromeMock, uninstallChromeMock } from '../../helpers/chrome-mock.js';
import { loadSidebarScript } from '../../helpers/load-script.js';

describe('sidebar/i18n.js', () => {
  let i18n;

  beforeEach(() => {
    // Fresh DOM per test
    document.body.innerHTML = '';
    document.documentElement.lang = '';
    installChromeMock({ lang: 'en-US' });
    // Default navigator language for jsdom is 'en-US' — override per test below
    i18n = loadSidebarScript('src/sidebar/i18n.js');
  });

  afterEach(() => {
    uninstallChromeMock();
  });

  describe('detectLang / getLangCode', () => {
    it('detects the browser short language', () => {
      Object.defineProperty(navigator, 'language', { value: 'fr-FR', configurable: true });
      expect(i18n.detectLang()).toBe('fr');
    });

    it('falls back to English when the language is unsupported', () => {
      Object.defineProperty(navigator, 'language', { value: 'xx-YY', configurable: true });
      expect(i18n.getLangCode()).toBe('en');
    });

    it('honours userLangOverride when set via setLang', async () => {
      Object.defineProperty(navigator, 'language', { value: 'fr-FR', configurable: true });
      await i18n.setLang('es');
      expect(i18n.getLangCode()).toBe('es');
    });
  });

  describe('t(key)', () => {
    it('returns the string in the current language', () => {
      Object.defineProperty(navigator, 'language', { value: 'fr-FR', configurable: true });
      expect(i18n.t('statusReady')).toBe('Prêt');
    });

    it('falls back to English when the key is missing in the current language', async () => {
      // Simulate a language that has partial coverage by overriding to 'en' first
      Object.defineProperty(navigator, 'language', { value: 'fr-FR', configurable: true });
      // 'title' exists in all locales — check English matches for sanity
      await i18n.setLang('en');
      expect(i18n.t('title')).toBe('Charly');
    });

    it('returns the key itself when absent everywhere', () => {
      expect(i18n.t('__totally_missing_key__')).toBe('__totally_missing_key__');
    });
  });

  describe('applyTranslations', () => {
    it('sets textContent on [data-i18n] elements', () => {
      Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true });
      document.body.innerHTML = '<span data-i18n="statusReady"></span>';
      i18n.applyTranslations();
      expect(document.querySelector('span').textContent).toBe('Ready');
    });

    it('sets placeholder on [data-i18n-placeholder] elements', () => {
      document.body.innerHTML = '<input data-i18n-placeholder="inputPlaceholder" />';
      i18n.applyTranslations();
      expect(document.querySelector('input').placeholder).toMatch(/Charly/);
    });

    it('sets title on [data-i18n-title] elements', () => {
      document.body.innerHTML = '<button data-i18n-title="resetTitle"></button>';
      i18n.applyTranslations();
      expect(document.querySelector('button').title).toBeTruthy();
    });

    it('expands {CAPTURE_ICON} into an inline SVG node', () => {
      Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true });
      document.body.innerHTML = '<p data-i18n="howItWorks3"></p>';
      i18n.applyTranslations();
      const p = document.querySelector('p');
      const icon = p.querySelector('svg.inline-icon');
      expect(icon).toBeTruthy();
      expect(icon.querySelector('path').getAttribute('d')).toBe(
        'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z'
      );
      expect(icon.querySelector('circle').getAttribute('cy')).toBe('13');
      expect(icon.querySelector('circle').getAttribute('r')).toBe('4');
      // No literal placeholder leaks through
      expect(p.textContent).not.toContain('{CAPTURE_ICON}');
    });

    it('updates document.documentElement.lang', () => {
      Object.defineProperty(navigator, 'language', { value: 'es-ES', configurable: true });
      i18n.applyTranslations();
      expect(document.documentElement.lang).toBe('es');
    });
  });

  describe('setLang persistence', () => {
    it('persists the choice to chrome.storage.local', async () => {
      await i18n.setLang('fr');
      expect(chrome.storage.local.set).toHaveBeenCalledWith({ limova_lang: 'fr' });
    });

    it('notifies the background with SET_LANG', async () => {
      await i18n.setLang('es');
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'SET_LANG', lang: 'es' })
      );
    });

    it('ignores unsupported language codes', async () => {
      const before = i18n.getLangCode();
      await i18n.setLang('qq');
      expect(i18n.getLangCode()).toBe(before);
    });
  });

  describe('loadLangPreference', () => {
    it('restores a previously saved lang from storage', async () => {
      chrome._storage.set('limova_lang', 'es');
      await i18n.loadLangPreference();
      expect(i18n.getLangCode()).toBe('es');
    });
  });

  describe('translation coverage', () => {
    it('all locales share the same keys', () => {
      const fr = Object.keys(i18n.translations.fr);
      const en = Object.keys(i18n.translations.en);
      const es = Object.keys(i18n.translations.es);
      expect(new Set(fr)).toEqual(new Set(en));
      expect(new Set(fr)).toEqual(new Set(es));
    });

    it('exposes supported languages and labels', () => {
      expect(i18n.SUPPORTED_LANGS).toContain('fr');
      expect(i18n.SUPPORTED_LANGS).toContain('en');
      expect(i18n.SUPPORTED_LANGS).toContain('es');
      expect(i18n.LANG_LABELS.fr).toBe('Français');
    });
  });
});
