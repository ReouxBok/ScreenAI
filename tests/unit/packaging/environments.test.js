import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extensionEnvironment, environmentManifest, environmentModule, STAGING_EXTENSION_KEY } from '../../../scripts/extension-environments.mjs';

const source = JSON.parse(readFileSync(new URL('../../../manifest.json', import.meta.url), 'utf8'));
const extensionId = key => [...createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16)]
  .flatMap(byte => [String.fromCharCode(97 + (byte >> 4)), String.fromCharCode(97 + (byte & 15))]).join('');

describe('extension environment packaging', () => {
  it('preserves the production identity and manifest', () => {
    expect(environmentManifest(source, extensionEnvironment('production'))).toEqual(source);
    expect(readFileSync(new URL('../../../src/limova/environment.js', import.meta.url), 'utf8'))
      .toBe(environmentModule(extensionEnvironment('production')));
  });
  it('isolates staging identity, injection and network permissions', () => {
    const snapshot = structuredClone(source);
    const staging = environmentManifest(source, extensionEnvironment('staging'));
    expect(source).toEqual(snapshot);
    expect(staging.name).toBe('Limova AI — Staging');
    expect(staging.key).toBe(STAGING_EXTENSION_KEY);
    expect(extensionId(staging.key)).not.toBe(extensionId(source.key));
    expect(staging.host_permissions).toEqual(['https://api.staging.new.limova.ai/*', 'https://staging.new.limova.ai/*']);
    expect(staging.content_scripts.every(script => JSON.stringify(script.matches) === JSON.stringify(['https://staging.new.limova.ai/*']))).toBe(true);
    expect(staging.content_security_policy.extension_pages).toContain('connect-src https://api.staging.new.limova.ai;');
    expect(staging.content_security_policy.extension_pages).not.toMatch(/studio|heroku|vercel/);
    expect(staging.permissions).toEqual(source.permissions);
    expect(staging.permissions).not.toContain('cookies');
  });
  it.each(['', 'preview', '../production', 'Production', undefined])('rejects unknown environment %s', name => {
    expect(() => extensionEnvironment(name)).toThrow('production or staging');
  });
});
