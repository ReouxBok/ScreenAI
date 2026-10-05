import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const bracesException = Object.freeze({
  url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
  dependency: 'braces',
  version: '3.0.3',
  severity: 'high',
  reviewedAt: '2026-10-05T00:00:00Z',
  expiresAt: '2026-10-12T00:00:00Z',
  owner: 'Ugo Le Bras',
});

const severities = new Set(['info', 'low', 'moderate', 'high', 'critical']);
const blocking = (severity) => severity === 'high' || severity === 'critical';

/** Fail closed: an exception applies to an advisory, never an entire dependency tree. */
export function evaluateAudit(report, lock, now = new Date()) {
  if (report?.error || report?.auditReportVersion !== 2 || !report.vulnerabilities
    || typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities)
    || !report.metadata?.vulnerabilities || !lock?.packages) {
    throw new Error('Invalid or failed npm audit / lockfile');
  }
  const nodes = report.vulnerabilities;
  const counts = Object.fromEntries([...severities].map((severity) => [severity, 0]));
  for (const [name, node] of Object.entries(nodes)) {
    if (node?.name !== name || !severities.has(node.severity) || !Array.isArray(node.via)
      || node.via.length === 0 || !Array.isArray(node.nodes) || node.nodes.length === 0) {
      throw new Error(`Invalid audit node: ${name}`);
    }
    counts[node.severity]++;
    for (const via of node.via) {
      if (typeof via === 'string') {
        if (!Object.hasOwn(nodes, via)) throw new Error(`Missing audit dependency: ${via}`);
      } else if (!via || !severities.has(via.severity) || typeof via.url !== 'string'
        || typeof via.dependency !== 'string') throw new Error(`Invalid advisory: ${name}`);
    }
  }
  for (const severity of severities) {
    if (counts[severity] !== report.metadata.vulnerabilities[severity]) {
      throw new Error(`Audit count mismatch: ${severity}`);
    }
  }
  const rejected = new Set();
  const accepted = new Set();
  const visit = (name, ancestry = new Set()) => {
    if (ancestry.has(name)) throw new Error(`Cyclic blocking audit chain: ${name}`);
    const node = nodes[name];
    const next = new Set([...ancestry, name]);
    let found = false;
    for (const via of node.via) {
      if (typeof via === 'string') {
        if (blocking(nodes[via].severity)) found = visit(via, next) || found;
      } else if (blocking(via.severity)) {
        found = true;
        const exceptionMatches = name === 'braces' && via.dependency === bracesException.dependency
          && via.url === bracesException.url && via.severity === bracesException.severity
          && node.severity === 'high' && via.range === '<=3.0.3'
          && node.nodes.every((location) => lock.packages[location]?.version === bracesException.version)
          && Number.isFinite(now.getTime())
          && now >= new Date(bracesException.reviewedAt) && now < new Date(bracesException.expiresAt);
        (exceptionMatches ? accepted : rejected).add(via.url);
      }
    }
    if (!found) throw new Error(`Blocking audit node has no blocking advisory: ${name}`);
    return found;
  };
  for (const [name, node] of Object.entries(nodes)) if (blocking(node.severity)) visit(name);
  return { counts, accepted: [...accepted], rejected: [...rejected], ok: rejected.size === 0 };
}

export function runAudit(prefix = '.', now = new Date()) {
  const cwd = path.resolve(prefix);
  const audit = spawnSync('npm', ['audit', '--json'], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (audit.error || ![0, 1].includes(audit.status)) throw new Error('npm audit could not complete');
  const report = JSON.parse(audit.stdout);
  const lock = JSON.parse(readFileSync(path.join(cwd, 'package-lock.json'), 'utf8'));
  const result = evaluateAudit(report, lock, now);
  console.log(JSON.stringify({ scope: prefix, ...result }, null, 2));
  if (result.accepted.length) console.warn(`::warning::Temporary braces exception, approved by ${bracesException.owner}; expires ${bracesException.expiresAt}. Vulnerability remains present. See studio/docs/SAV_V0_SECURITY.md.`);
  if (!result.ok) process.exitCode = 1;
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args[0] && !['.', 'proxy', 'studio'].includes(args[0]))) throw new Error('Usage: node scripts/audit-dependencies.mjs [.|proxy|studio]');
    runAudit(args[0]);
  } catch (error) {
    console.error(`Dependency audit failed: ${error.message}`);
    process.exitCode = 1;
  }
}
