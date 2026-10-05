import { describe, expect, it } from 'vitest';
import { bracesException, evaluateAudit } from '../../scripts/audit-dependencies.mjs';

const now = new Date('2026-10-05T12:00:00Z');
function fixture() {
  return {
    report: {
      auditReportVersion: 2,
      vulnerabilities: {
        braces: { name: 'braces', severity: 'high', nodes: ['node_modules/braces'], via: [{ ...bracesException, range: '<=3.0.3' }] },
        micromatch: { name: 'micromatch', severity: 'high', nodes: ['node_modules/micromatch'], via: ['braces'] },
      },
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 2, critical: 0 } },
    },
    lock: { packages: { 'node_modules/braces': { version: '3.0.3' } } },
  };
}
describe('temporary advisory-scoped security gate', () => {
  it('accepts only the approved advisory and its inherited chains', () => {
    const { report, lock } = fixture();
    expect(evaluateAudit(report, lock, now)).toMatchObject({ ok: true, accepted: [bracesException.url] });
  });
  it.each(['high', 'critical'])('rejects another %s advisory on the same package', (severity) => {
    const { report, lock } = fixture();
    report.vulnerabilities.braces.via.push({ dependency: 'braces', severity, url: 'https://github.com/advisories/GHSA-other' });
    expect(evaluateAudit(report, lock, now).ok).toBe(false);
  });
  it.each(['2026-10-04T23:59:59Z', '2026-10-12T00:00:00Z'])('rejects outside the approval period: %s', (date) => {
    const { report, lock } = fixture();
    expect(evaluateAudit(report, lock, new Date(date)).ok).toBe(false);
  });
  it('rejects a different installed version', () => {
    const { report, lock } = fixture();
    lock.packages['node_modules/braces'].version = '3.0.2';
    expect(evaluateAudit(report, lock, now).ok).toBe(false);
  });
  it('rejects unknown dependency nodes', () => {
    const { report, lock } = fixture();
    report.vulnerabilities.micromatch.via.push('unknown');
    expect(() => evaluateAudit(report, lock, now)).toThrow('Missing audit dependency');
  });
  it('rejects cyclic blocking chains', () => {
    const { report, lock } = fixture();
    report.vulnerabilities.braces.via.push('micromatch');
    expect(() => evaluateAudit(report, lock, now)).toThrow('Cyclic');
  });
  it('rejects incomplete counts and npm error responses', () => {
    const { report, lock } = fixture();
    expect(() => evaluateAudit({ ...report, error: { code: 'NETWORK' } }, lock, now)).toThrow();
    report.metadata.vulnerabilities.high = 0;
    expect(() => evaluateAudit(report, lock, now)).toThrow('count mismatch');
  });
  it('rejects malformed reports or missing lockfiles', () => {
    expect(() => evaluateAudit({}, {}, now)).toThrow();
  });
});
