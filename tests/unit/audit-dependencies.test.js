import { describe, expect, it } from 'vitest';
import { evaluateAudit, picomatchException } from '../../scripts/audit-dependencies.mjs';

import { bracesAdvisory } from '../../scripts/verify-braces-remediation.mjs';
const verified = new Set(['node_modules/braces']);
function fixture() {
  return {
    report: {
      auditReportVersion: 2,
      vulnerabilities: {
        braces: { name: 'braces', severity: 'high', nodes: ['node_modules/braces'], via: [{ dependency: 'braces', severity: 'high', url: bracesAdvisory, range: '<=3.0.3' }] },
        micromatch: { name: 'micromatch', severity: 'high', nodes: ['node_modules/micromatch'], via: ['braces'] },
      },
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 2, critical: 0 } },
    },
    lock: { packages: { 'node_modules/braces': { version: '3.0.3' } } },
  };
}
describe('verified advisory-scoped local remediation', () => {
  it('accepts only the byte-verified advisory and its inherited chains', () => {
    const { report, lock } = fixture();
    expect(evaluateAudit(report, lock, verified)).toMatchObject({ ok: true, remediated: [bracesAdvisory] });
  });
  it.each(['high', 'critical'])('rejects another %s advisory on the same package', (severity) => {
    const { report, lock } = fixture();
    report.vulnerabilities.braces.via.push({ dependency: 'braces', severity, url: 'https://github.com/advisories/GHSA-other' });
    expect(evaluateAudit(report, lock, verified).ok).toBe(false);
  });
  it('rejects the original unpatched package, with no date-based allowance', () => {
    const { report, lock } = fixture();
    expect(evaluateAudit(report, lock).ok).toBe(false);
  });
  it('requires every reported nested copy to be verified', () => {
    const { report, lock } = fixture();
    report.vulnerabilities.braces.nodes.push('node_modules/other/node_modules/braces');
    expect(evaluateAudit(report, lock, verified).ok).toBe(false);
  });
  it('rejects a different installed version', () => {
    const { report, lock } = fixture();
    lock.packages['node_modules/braces'].version = '3.0.2';
    expect(evaluateAudit(report, lock, verified).ok).toBe(false);
  });
  it('rejects unknown dependency nodes', () => {
    const { report, lock } = fixture();
    report.vulnerabilities.micromatch.via.push('unknown');
    expect(() => evaluateAudit(report, lock, verified)).toThrow('Missing audit dependency');
  });
  it('rejects cyclic blocking chains', () => {
    const { report, lock } = fixture();
    report.vulnerabilities.braces.via.push('micromatch');
    expect(() => evaluateAudit(report, lock, verified)).toThrow('Cyclic');
  });
  it('rejects incomplete counts and npm error responses', () => {
    const { report, lock } = fixture();
    expect(() => evaluateAudit({ ...report, error: { code: 'NETWORK' } }, lock, verified)).toThrow('Invalid or failed');
    report.metadata.vulnerabilities.high = 0;
    expect(() => evaluateAudit(report, lock, verified)).toThrow('count mismatch');
  });
  it('rejects malformed reports or missing lockfiles', () => {
    expect(() => evaluateAudit({}, {}, verified)).toThrow();
  });
});

describe('temporary picomatch exception (GHSA-fc5q-39xc-vjpf, no patched release)', () => {
  const inWindow = new Date('2026-11-20T00:00:00Z');
  function pico(version = '4.0.5') {
    return {
      report: {
        auditReportVersion: 2,
        vulnerabilities: {
          picomatch: { name: 'picomatch', severity: 'high', nodes: ['node_modules/picomatch'], via: [{ dependency: 'picomatch', severity: 'high', url: picomatchException.url, range: '<=4.0.7' }] },
          tinyglobby: { name: 'tinyglobby', severity: 'high', nodes: ['node_modules/tinyglobby'], via: ['picomatch'] },
        },
        metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 2, critical: 0 } },
      },
      lock: { packages: { 'node_modules/picomatch': { version } } },
    };
  }
  it.each(['2.3.2', '4.0.5', '4.0.7'])('accepts the exact advisory on reviewed version %s and its inherited chains', (version) => {
    const { report, lock } = pico(version);
    expect(evaluateAudit(report, lock, new Set(), inWindow)).toMatchObject({ ok: true, excepted: [picomatchException.url], rejected: [] });
  });
  it('expires on 2026-12-01 and is not active before review', () => {
    const { report, lock } = pico();
    expect(evaluateAudit(report, lock, new Set(), new Date('2026-12-01T00:00:00Z')).ok).toBe(false);
    expect(evaluateAudit(report, lock, new Set(), new Date('2026-11-17T23:59:59Z')).ok).toBe(false);
    expect(evaluateAudit(report, lock, new Set(), new Date('invalid')).ok).toBe(false);
  });
  it('rejects an unreviewed installed version', () => {
    const { report, lock } = pico('4.0.6');
    expect(evaluateAudit(report, lock, new Set(), inWindow).ok).toBe(false);
  });
  it('requires every reported copy to be a reviewed version', () => {
    const { report, lock } = pico();
    report.vulnerabilities.picomatch.nodes.push('node_modules/x/node_modules/picomatch');
    lock.packages['node_modules/x/node_modules/picomatch'] = { version: '3.0.1' };
    expect(evaluateAudit(report, lock, new Set(), inWindow).ok).toBe(false);
  });
  it('rejects a widened range or another advisory on picomatch', () => {
    const widened = pico();
    widened.report.vulnerabilities.picomatch.via[0].range = '<=4.0.9';
    expect(evaluateAudit(widened.report, widened.lock, new Set(), inWindow).ok).toBe(false);
    const other = pico();
    other.report.vulnerabilities.picomatch.via.push({ dependency: 'picomatch', severity: 'critical', url: 'https://github.com/advisories/GHSA-other' });
    expect(evaluateAudit(other.report, other.lock, new Set(), inWindow).ok).toBe(false);
  });
  it('never applies to another package carrying the same advisory url', () => {
    const { report, lock } = pico();
    report.vulnerabilities.tinyglobby.via = [{ dependency: 'tinyglobby', severity: 'high', url: picomatchException.url, range: '<=4.0.7' }];
    expect(evaluateAudit(report, lock, new Set(), inWindow).ok).toBe(false);
  });
});
