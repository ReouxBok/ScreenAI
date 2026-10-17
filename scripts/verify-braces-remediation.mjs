import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const bracesAdvisory = 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm';
const sha = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest(algorithm === 'sha512' ? 'base64' : 'hex');

function installedLocations(cwd) {
  const found = [];
  const visit = modules => {
    if (!existsSync(modules)) return;
    for (const item of readdirSync(modules, { withFileTypes: true })) {
      if (item.name.startsWith('.')) continue;
      const folder = path.join(modules, item.name);
      if (item.name === 'braces') found.push(path.relative(cwd, folder).split(path.sep).join('/'));
      if (!item.isDirectory()) continue;
      if (item.name.startsWith('@')) {
        for (const child of readdirSync(folder)) visit(path.join(folder, child, 'node_modules'));
      } else visit(path.join(folder, 'node_modules'));
    }
  };
  visit(path.join(cwd, 'node_modules'));
  return found.sort();
}

/** Verify the code actually installed, independently of whether npm reports local packages. */
export function verifyBracesRemediation(cwd, lock) {
  cwd = realpathSync(cwd);
  const manifest = JSON.parse(readFileSync(path.join(root, 'vendor/braces-remediation.json'), 'utf8'));
  const locations = Object.keys(lock.packages).filter(key => /(?:^|\/)node_modules\/braces$/.test(key));
  if (JSON.stringify([...locations].sort()) !== JSON.stringify(installedLocations(cwd))) throw Error('Braces installed inventory differs from lock');
  if (!locations.length) return new Set();
  if (manifest.advisory !== bracesAdvisory || manifest.version !== '3.0.3' || manifest.patchRevision !== 'screenai.1') throw Error('Unknown braces remediation');
  if (`sha512-${sha(readFileSync(path.join(cwd, manifest.archive)), 'sha512')}` !== manifest.integrity) throw Error('Braces archive integrity mismatch');
  const verified = new Set();
  for (const location of locations) {
    const entry = lock.packages[location];
    if (entry.link || entry.version !== manifest.version || entry.resolved !== `file:${manifest.archive}` || entry.integrity !== manifest.integrity) throw Error(`Unremediated braces lock: ${location}`);
    const folder = path.resolve(cwd, location);
    if (realpathSync(folder) !== folder) throw Error(`Braces package symlink refused: ${location}`);
    for (const [file, digest] of Object.entries(manifest.files)) {
      const installed = path.join(folder, file);
      if (realpathSync(installed) !== installed || sha(readFileSync(installed)) !== digest) throw Error(`Braces installed code mismatch: ${location}/${file}`);
      if (sha(readFileSync(path.join(root, 'vendor/braces', file))) !== digest) throw Error(`Braces source mismatch: ${file}`);
    }
    verified.add(location);
  }
  return verified;
}
