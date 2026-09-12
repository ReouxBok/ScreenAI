import { describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const proxyDir = path.resolve(here, '..', '..', 'proxy');
const requireFromProxy = createRequire(path.join(proxyDir, 'package.json'));

const { sanitizeKnowledgeResponse } = requireFromProxy('./copilot/knowledge.js');

describe('ADK knowledge response', () => {
  test('preserves validated action hints for published Studio journeys', () => {
    const response = sanitizeKnowledgeResponse({
      revision: 'kb_1',
      results: [{
        id: 'journey-1',
        title: 'Connecter Gmail',
        content: 'Ouvrez les intégrations.',
        score: 0.91,
        source: 'connecter-gmail',
        actionHints: [{
          order: 1,
          action: 'click',
          path: '/integrations/catalog',
          label: 'Connecter Gmail',
          confidence: 'strong',
          target: { role: 'button', ariaLabel: 'Connecter Gmail', ignored: 'secret' },
          preconditions: ['h1: Intégrations'],
          expected: { path: '/integrations/connected-accounts', pageMarkers: ['Gmail'], network: [] },
        }],
      }],
    });

    expect(response.results[0].actionHints).toEqual([expect.objectContaining({
      action: 'click',
      label: 'Connecter Gmail',
      target: { role: 'button', ariaLabel: 'Connecter Gmail' },
    })]);
  });

  test('drops malformed action hints', () => {
    const response = sanitizeKnowledgeResponse({ results: [{ actionHints: [{ action: 'run_script' }] }] });
    expect(response.results[0]).not.toHaveProperty('actionHints');
  });
});
