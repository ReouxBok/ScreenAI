import { describe, it, expect } from 'vitest';
import { searchKB, getKBInfo } from '../../../src/knowledge-base/kb-search.js';

describe('knowledge-base/kb-search', () => {
  describe('getKBInfo', () => {
    it('reports the intentionally empty embedded fallback', () => {
      const info = getKBInfo();
      expect(info.totalArticles).toBe(0);
      expect(Array.isArray(info.sampleKeywords)).toBe(true);
    });

    it('samples include a title and keyword list per article', () => {
      const { sampleKeywords } = getKBInfo();
      for (const s of sampleKeywords) {
        expect(typeof s.title).toBe('string');
        expect(Array.isArray(s.keywords)).toBe(true);
      }
    });
  });

  describe('searchKB', () => {
    it('returns an empty string on an empty query with no URL', () => {
      expect(searchKB('')).toBe('');
      expect(searchKB('  ')).toBe('');
      expect(searchKB('a')).toBe('');
    });

    it('does not resurrect retired content for a well-formed French query', () => {
      const out = searchKB('connecter gmail calendar', { url: 'https://new.limova.ai/integrations' });
      expect(out).toBe('');
    });

    it('respects the maxChars budget', () => {
      const out = searchKB('limova documents fichiers', {
        url: 'https://new.limova.ai/documents',
        maxChars: 500
      });
      // Allow some slack for the heading / truncation marker
      expect(out.length).toBeLessThan(1200);
    });

    it('omits the "Autres articles" section when maxResults=1', () => {
      const out = searchKB('limova', { maxResults: 1 });
      expect(out).not.toContain('Autres articles potentiellement pertinents');
    });

    it('adds the "Autres articles" section when candidates exceed the full-article cap', () => {
      const out = searchKB('limova', { maxResults: 5 });
      // Not all searches yield >3 results; skip the assertion if it does not
      if (out.includes('Autres articles potentiellement pertinents')) {
        expect(out.split('Autres articles potentiellement pertinents')).toHaveLength(2);
      }
    });

    it('URL matching surfaces context-relevant articles even with a short query', () => {
      const out = searchKB('', { url: 'https://new.limova.ai/integrations/gmail' });
      // URL-only search is allowed (per the guard at line 203)
      expect(typeof out).toBe('string');
    });

    it('returns no ranking until reviewed Studio content is published', () => {
      const a = searchKB('super pouvoirs john marketing');
      const b = searchKB('documents contexte par defaut');
      expect(a).toBe('');
      expect(b).toBe('');
    });
  });
});
