/**
 * Load a classic (non-module) script file into the current jsdom global scope.
 * Used to test sidebar scripts that run as <script src=...> (no ES module exports).
 *
 * The script's top-level `const/let/function` bindings become available on
 * globalThis via a `with(globalThis)` trampoline. This is fine here because
 * jsdom test files own the global scope and are disposable per test file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');

export function loadSidebarScript(relativePath) {
  const abs = path.join(projectRoot, relativePath);
  const source = fs.readFileSync(abs, 'utf8');
  // Execute in global scope. Using new Function so `this` is globalThis.
  // eslint-disable-next-line no-new-func
  const run = new Function(`${source}\n;return { ${extractTopLevelNames(source).join(', ')} };`);
  const exports = run.call(globalThis);
  // Attach exports to globalThis so subsequent calls can find them
  for (const [k, v] of Object.entries(exports)) {
    globalThis[k] = v;
  }
  return exports;
}

function extractTopLevelNames(source) {
  const names = new Set();
  // Match: const FOO = / let foo = / var foo = / function foo( / async function foo(
  const re = /^(?:const|let|var|function|async\s+function)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(source)) !== null) names.add(m[1]);
  return [...names];
}
