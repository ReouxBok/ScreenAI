import fs from 'node:fs';
import path from 'node:path';

const target = path.resolve(process.argv[2] || process.cwd());
const manifestPath = path.join(target, 'manifest.json');
const failures = [];

function requireFile(relativePath, source) {
  if (!relativePath || typeof relativePath !== 'string') return;
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
    failures.push(`${source}: unsafe path "${relativePath}"`);
    return;
  }
  const absolute = path.join(target, relativePath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    failures.push(`${source}: missing file "${relativePath}"`);
  }
}

if (!fs.existsSync(manifestPath)) {
  console.error(`Package invalid: manifest.json is missing at ${target}`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (error) {
  console.error(`Package invalid: manifest.json cannot be parsed (${error.message})`);
  process.exit(1);
}

if (manifest.manifest_version !== 3) failures.push('manifest_version must be 3');
if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version || '')) failures.push('version is invalid');
if (Number.parseInt(manifest.minimum_chrome_version, 10) < 114) {
  failures.push('minimum_chrome_version must cover the Side Panel API (114+)');
}

const expectedPermissions = ['activeTab', 'sidePanel', 'storage', 'scripting', 'webNavigation'];
const actualPermissions = [...(manifest.permissions || [])].sort();
if (JSON.stringify(actualPermissions) !== JSON.stringify([...expectedPermissions].sort())) {
  failures.push(`permissions must stay least-privilege: ${expectedPermissions.join(', ')}`);
}
const expectedHosts = [
  'https://new.limova.ai/*',
  'https://studio.limova.ai/*',
  'https://vercel.com/*',
  'https://pihloilpc5svuzjv.private.blob.vercel-storage.com/*',
  'https://limova-proxy-479c7fb78ccf.herokuapp.com/*'
];
const actualHosts = [...(manifest.host_permissions || [])].sort();
if (JSON.stringify(actualHosts) !== JSON.stringify([...expectedHosts].sort())) {
  failures.push(`host_permissions must stay restricted to: ${expectedHosts.join(', ')}`);
}
const extensionCsp = manifest.content_security_policy?.extension_pages || '';
if (!extensionCsp.includes("script-src 'self'")) failures.push("CSP must restrict scripts to 'self'");
if (!extensionCsp.includes('connect-src') || !extensionCsp.includes('https://vercel.com')) {
  failures.push('CSP must allow the Vercel Blob client upload API');
}
if (/unsafe-(?:eval|inline)/.test(extensionCsp)) failures.push('CSP must not allow unsafe-eval or unsafe-inline');

Object.values(manifest.icons || {}).forEach(file => requireFile(file, 'icons'));
requireFile(manifest.action?.default_icon, 'action.default_icon');
requireFile(manifest.background?.service_worker, 'background.service_worker');
requireFile(manifest.side_panel?.default_path, 'side_panel.default_path');
for (const [index, script] of (manifest.content_scripts || []).entries()) {
  for (const file of script.js || []) requireFile(file, `content_scripts[${index}].js`);
  for (const file of script.css || []) requireFile(file, `content_scripts[${index}].css`);
}
for (const [index, group] of (manifest.web_accessible_resources || []).entries()) {
  for (const file of group.resources || []) {
    if (!file.includes('*')) requireFile(file, `web_accessible_resources[${index}]`);
  }
}

const htmlFiles = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else if (entry.name.endsWith('.html')) htmlFiles.push(absolute);
    if (/^(\.env|.*\.(pem|key|p12|map))$/i.test(entry.name)) {
      failures.push(`forbidden release artifact: ${path.relative(target, absolute)}`);
    }
  }
}
for (const directory of ['src', 'assets']) {
  const absolute = path.join(target, directory);
  if (fs.existsSync(absolute)) walk(absolute);
}

for (const htmlFile of htmlFiles) {
  const html = fs.readFileSync(htmlFile, 'utf8');
  const attributePattern = /<(script|link|img)\b[^>]*?\b(?:src|href)=["']([^"']+)["']/gi;
  for (const match of html.matchAll(attributePattern)) {
    const [, tag, reference] = match;
    if (/^https?:/i.test(reference)) {
      failures.push(`${path.relative(target, htmlFile)}: remote ${tag} resource is forbidden (${reference})`);
      continue;
    }
    if (/^(?:data:|blob:|#)/i.test(reference)) continue;
    const resolved = path.resolve(path.dirname(htmlFile), reference);
    const relative = path.relative(target, resolved);
    requireFile(relative, path.relative(target, htmlFile));
  }

  for (const match of html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (match[1].trim()) failures.push(`${path.relative(target, htmlFile)}: inline script is forbidden`);
  }
}

if (failures.length) {
  console.error('Package invalid:');
  failures.forEach(failure => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`Package valid: ${manifest.name} v${manifest.version}`);
console.log(`Side panel verified: ${manifest.side_panel.default_path}`);
