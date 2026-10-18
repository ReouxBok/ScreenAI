import { describe, expect, it } from 'vitest';
import { evaluateAudit } from '../../scripts/audit-dependencies.mjs';

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
