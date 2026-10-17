import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyBracesRemediation } from '../../scripts/verify-braces-remediation.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const requireProxy = createRequire(path.join(root, 'proxy/package.json'));
const braces = requireProxy('braces');
const manifest = JSON.parse(readFileSync(path.join(root, 'vendor/braces-remediation.json'), 'utf8'));
const temporary = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const nested = (depth, open = '{', close = '}') => open.repeat(depth) + 'x' + close.repeat(depth);
const rejectsDepth = fn => {
  try { fn(); throw Error('Expected depth rejection'); } catch (error) {
    expect(error).toBeInstanceOf(SyntaxError);
    expect(error.code).toBe('ERR_BRACES_DEPTH');
  }
};

describe('bounded brace recursion', () => {
  it.each(['{', '('])('bounds actual parser nesting for %s including unbalanced input', open => {
    const close = open === '{' ? '}' : ')';
    expect(() => braces.parse(nested(128, open, close))).not.toThrow();
    rejectsDepth(() => braces.parse(nested(129, open, close), { maxDepth: Infinity, maxLength: Infinity }));
    rejectsDepth(() => braces.parse(open.repeat(6000) + 'x'));
    rejectsDepth(() => braces(nested(4000, open, close)));
  });
  it('counts mixed nesting but preserves escaped, quoted and bracketed literals', () => {
    rejectsDepth(() => braces.parse('{('.repeat(65) + 'x' + ')}'.repeat(65)));
    for (const value of ['\\{'.repeat(200), '"' + '{'.repeat(200) + '"', '[' + '{'.repeat(200) + ']']) expect(() => braces.parse(value)).not.toThrow();
  });
  it.each(['compile', 'expand', 'stringify'])('bounds %s for direct ASTs and cycles', method => {
    let ast = { type: 'text', value: 'x' };
    for (let n = 0; n < 6000; n++) ast = { type: 'root', nodes: [ast] };
    rejectsDepth(() => braces[method](ast));
    const cyclic = { type: 'root', nodes: [] }; cyclic.nodes.push(cyclic);
    rejectsDepth(() => braces[method](cyclic));
  });
  it('bounds crafted cyclic parent links in expansion', () => {
    const parent = { type: 'paren', nodes: [] }; parent.parent = parent;
    const child = { type: 'paren', nodes: [], parent }; parent.nodes.push(child);
    rejectsDepth(() => braces.expand({ type: 'root', nodes: [parent] }));
  });
  it('preserves ordinary compile/expand/stringify and options', () => {
    expect(braces('src/{a,b}/*.js')).toEqual(['src/(a|b)/*.js']);
    expect(braces.expand('v{01..03}')).toEqual(['v01', 'v02', 'v03']);
    expect(braces(['{a,a}', '{b,c}'], { expand: true, nodupes: true })).toEqual(['a', 'b', 'c']);
    expect(braces.expand('{,a,a}', { noempty: true, nodupes: true })).toEqual(['a']);
    const ast = braces.parse('a/{b,c}/d');
    expect(braces.stringify(ast)).toBe('a/{b,c}/d');
    expect(braces.compile(ast)).toBe('a/(b|c)/d');
    expect(() => braces.expand('{1..10000}')).toThrow('range limit');
    expect(requireProxy('micromatch')(['src/a.ts', 'src/a.js', 'test/b.ts'], 'src/*.{ts,js}')).toEqual(['src/a.ts', 'src/a.js']);
  });
});

function installation() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'braces-integrity-')); temporary.push(cwd);
  mkdirSync(path.join(cwd, 'vendor'));
  cpSync(path.join(root, 'proxy', manifest.archive), path.join(cwd, manifest.archive));
  cpSync(path.join(root, 'vendor/braces'), path.join(cwd, 'node_modules/braces'), { recursive: true });
  const entry = { version: '3.0.3', resolved: `file:${manifest.archive}`, integrity: manifest.integrity };
  return { cwd, entry, lock: { packages: { 'node_modules/braces': entry } } };
}
describe('installed source and archive integrity, independent of audit results', () => {
  it('verifies all installed copies and still works after the former deadline', () => {
    const { cwd, entry, lock } = installation();
    cpSync(path.join(root, 'vendor/braces'), path.join(cwd, 'node_modules/other/node_modules/braces'), { recursive: true });
    lock.packages['node_modules/other/node_modules/braces'] = entry;
    expect([...verifyBracesRemediation(cwd, lock)]).toHaveLength(2);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
      expect(verifyBracesRemediation(cwd, lock).size).toBe(2);
    } finally { vi.useRealTimers(); }
  });
  it.each(['lib/compile.js', 'lib/parse.js', 'lib/limits.js', 'index.js', 'package.json'])('rejects changed or missing %s', file => {
    const { cwd, lock } = installation();
    writeFileSync(path.join(cwd, 'node_modules/braces', file), 'tampered');
    expect(() => verifyBracesRemediation(cwd, lock)).toThrow('code mismatch');
    rmSync(path.join(cwd, 'node_modules/braces', file));
    expect(() => verifyBracesRemediation(cwd, lock)).toThrow();
  });
  it('rejects a substituted archive or an upstream lock entry', () => {
    const { cwd, entry, lock } = installation();
    entry.resolved = 'https://registry.npmjs.org/braces/-/braces-3.0.3.tgz';
    expect(() => verifyBracesRemediation(cwd, lock)).toThrow('Unremediated');
    entry.resolved = `file:${manifest.archive}`;
    writeFileSync(path.join(cwd, manifest.archive), 'changed');
    expect(() => verifyBracesRemediation(cwd, lock)).toThrow('archive integrity');
  });
  it('rejects extra copies, missing copies and symbolic substitutions even with an empty audit', () => {
    const { cwd, lock } = installation();
    expect(() => verifyBracesRemediation(cwd, { packages: {} })).toThrow('inventory');
    rmSync(path.join(cwd, 'node_modules/braces'), { recursive: true });
    expect(() => verifyBracesRemediation(cwd, lock)).toThrow('inventory');
    symlinkSync(path.join(root, 'vendor/braces'), path.join(cwd, 'node_modules/braces'));
    expect(() => verifyBracesRemediation(cwd, lock)).toThrow('symlink refused');
  });
});
