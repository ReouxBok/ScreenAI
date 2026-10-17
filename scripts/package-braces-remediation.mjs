import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv[2] === '--check';
if (process.argv.length > (check ? 3 : 2)) throw Error('Usage: node scripts/package-braces-remediation.mjs [--check]');
const temporary = mkdtempSync(path.join(tmpdir(), 'braces-pack-'));
try {
  const packed = spawnSync('npm', ['pack', path.join(root, 'vendor/braces'), '--ignore-scripts', '--json', '--cache', path.join(temporary, 'cache'), '--pack-destination', temporary], { encoding: 'utf8', cwd: root, timeout: 30000 });
  if (packed.error || packed.status !== 0) throw Error('Could not pack the local braces source');
  const [{ filename }] = JSON.parse(packed.stdout);
  const archive = readFileSync(path.join(temporary, filename));
  const files = {};
  const visit = folder => {
    for (const item of readdirSync(path.join(root, 'vendor/braces', folder), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.posix.join(folder, item.name);
      if (item.isDirectory()) visit(file);
      else if (item.isFile() && (folder === 'lib' || ['index.js', 'package.json', 'LICENSE'].includes(file))) files[file] = createHash('sha256').update(readFileSync(path.join(root, 'vendor/braces', file))).digest('hex');
      else if (!item.isFile()) throw Error('Unexpected source file type');
    }
  };
  visit('');
  const manifest = { advisory: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm', version: '3.0.3', patchRevision: 'screenai.1', archive: 'vendor/braces-3.0.3-screenai.1.tgz', integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64'), files: Object.fromEntries(Object.entries(files).sort()) };
  for (const scope of ['proxy', 'studio']) {
    const destination = path.join(root, scope, manifest.archive);
    if (check) { if (!readFileSync(destination).equals(archive)) throw Error(`Archive differs from source: ${scope}`); }
    else copyFileSync(path.join(temporary, filename), destination);
  }
  const metadata = JSON.stringify(manifest, null, 2) + '\n';
  const destination = path.join(root, 'vendor/braces-remediation.json');
  if (check) { if (readFileSync(destination, 'utf8') !== metadata) throw Error('Remediation manifest differs from source'); }
  else writeFileSync(destination, metadata);
  console.log(check ? 'Braces archives and source are identical' : 'Braces archives and manifest rebuilt; update both locks next');
} finally { rmSync(temporary, { recursive: true, force: true }); }
