import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/*
 * Agent SAV intelligent (20/11): the runtime import graph of a module, for the « no effect » tests (Astra: indirect imports count too).
 * Static imports, re-exports and dynamic `import()`, recursively through `@/` and relative paths; type-only imports are erased and skipped.
 * Test tooling only (reads source files); never imported by runtime code.
 */
const SPEC = /(?:^|[;\n}])\s*(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
function resolveSpec(from: string, spec: string, src: string): string | null {
  const base = spec.startsWith("@/") ? path.join(src, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
  if (!base) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) if (existsSync(candidate) && candidate.match(/\.tsx?$/)) return candidate;
  return null;
}
/** Every runtime-reachable module of `entry` (files under src/), with the first path that reaches each. */
export function importGraph(entry: string, src: string) {
  const seen = new Map<string, string[]>([[entry, [entry]]]), queue = [entry];
  while (queue.length) {
    const file = queue.shift()!, source = readFileSync(file, "utf8");
    for (const match of source.matchAll(SPEC)) {
      const typeOnly = Boolean(match[2]), spec = match[3] ?? match[4];
      if (!spec || typeOnly) continue;
      const target = resolveSpec(file, spec, src);
      if (!target || seen.has(target)) continue;
      seen.set(target, [...seen.get(file)!, target]);
      queue.push(target);
    }
  }
  return seen;
}

