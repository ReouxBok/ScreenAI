import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { collectIntakeAuthoritySources, verifyIntakeAuthoritySources, writeIntakeAuthorityManifest } from "../../../../scripts/intake-authority.mjs";
let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });
function fixture() {
  root = mkdtempSync(path.join(os.tmpdir(), "intake-authority-fixture-"));
  const put = (filename: string, text: string) => { mkdirSync(path.dirname(path.join(root!, filename)), { recursive: true }); writeFileSync(path.join(root!, filename), text); };
  put("src/lib/sav/intake/entry.ts", 'import { allowed } from "@/permissions"; export const authority = allowed;');
  put("src/permissions.ts", "export const allowed = false;");
  put("scripts/intake-authority.mjs", "// synthetic verifier"); put("next.config.ts", "// synthetic build check");
  for (const file of ["package.json", "package-lock.json", "tsconfig.json"]) put(file, "{}");
  put("src/lib/sav/intake/authority-manifest.json", JSON.stringify({ authorityRevision: "sav-intake-authority-fixture.v1", ...collectIntakeAuthoritySources(root) }));
  return put;
}
it("verifies the actual covered sources, including verifier and build wiring", () => {
  const actual = verifyIntakeAuthoritySources();
  for (const name of ["compatibility.ts", "runtime-contract.ts", "execution-context.ts", "human-binding.ts", "budget-profile.ts", "launch-admin.ts"])
    expect(actual.sources).toHaveProperty(`src/lib/sav/intake/${name}`);
  expect(Object.hasOwn(actual.sources, "scripts/intake-authority.mjs")).toBe(true);
  expect(Object.hasOwn(actual.sources, "next.config.ts")).toBe(true);
  expect(Object.hasOwn(actual.sources, "src/lib/sav/intake/authority-manifest.json")).toBe(false);
});
it.each(["src/lib/sav/intake/entry.ts", "src/permissions.ts", "scripts/intake-authority.mjs", "next.config.ts", "package-lock.json", "tsconfig.json"])("detects changed authority source %s", filename => {
  const put = fixture(); expect(() => verifyIntakeAuthoritySources(root)).not.toThrow();
  put(filename, readFileSync(path.join(root!, filename), "utf8") + "\n ");
  expect(() => verifyIntakeAuthoritySources(root)).toThrow(/relever SAV_INTAKE_AUTHORITY_REVISION/);
  expect(() => verifyIntakeAuthoritySources(root)).toThrow(`changed sources: ${filename}`);
});
it("detects newly added intake sources and transitive imports", () => {
  const put = fixture(); put("src/lib/sav/intake/new-permission.ts", "export const allow = true;");
  expect(() => verifyIntakeAuthoritySources(root)).toThrow();
  put("src/lib/sav/intake/entry.ts", 'import "@/new-permission";'); put("src/new-permission.ts", "export const allow = true;");
  expect(() => verifyIntakeAuthoritySources(root)).toThrow();
});
it("rejects unresolved imports and non-literal dynamic imports", () => {
  const put = fixture(); put("src/lib/sav/intake/entry.ts", 'import "@/missing-permission";');
  expect(() => verifyIntakeAuthoritySources(root)).toThrow(/AUTHORITY_IMPORT_UNRESOLVED/);
  put("src/lib/sav/intake/entry.ts", 'const target = "./permission"; void import(target);');
  expect(() => verifyIntakeAuthoritySources(root)).toThrow(/AUTHORITY_DYNAMIC_IMPORT_REJECTED/);
});
it("rejects unreviewed resolution aliases and undeclared external imports", () => {
  const put = fixture();
  put("tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@hidden/*": ["./src/*"] } } }));
  expect(() => verifyIntakeAuthoritySources(root)).toThrow(/AUTHORITY_RESOLUTION_CONFIG_REJECTED/);
  put("tsconfig.json", "{}"); put("src/lib/sav/intake/entry.ts", 'import "@hidden/permissions";');
  expect(() => verifyIntakeAuthoritySources(root)).toThrow(/AUTHORITY_EXTERNAL_IMPORT_REJECTED/);
});
it("covers alternate source extensions and refuses ambiguous local package resolution", () => {
  const put = fixture(); put("src/permissions.js", "export const allowed = true;");
  expect(() => verifyIntakeAuthoritySources(root)).toThrow();
  expect(Object.hasOwn(collectIntakeAuthoritySources(root).sources, "src/permissions.js")).toBe(true);
  put("src/permissions/package.json", JSON.stringify({ main: "untracked.js" }));
  expect(() => verifyIntakeAuthoritySources(root)).toThrow(/AUTHORITY_LOCAL_PACKAGE_REJECTED/);
});
it("does not invalidate authority on a UI or test-only change", () => {
  const put = fixture(); put("src/app/page.tsx", "export default function Page() { return null; }");
  put("src/lib/sav/intake/example.test.ts", "// synthetic test");
  expect(() => verifyIntakeAuthoritySources(root)).not.toThrow();
});
it("detects newly introduced SQL affecting persistence guarantees", () => {
  const put = fixture(); put("drizzle/synthetic.sql", "-- synthetic change of persistence contract");
  expect(() => verifyIntakeAuthoritySources(root)).toThrow(/relever SAV_INTAKE_AUTHORITY_REVISION/);
});
it("requires a new revision to update the manifest and never repairs during verification", () => {
  const put = fixture(), file = path.join(root!, "src/lib/sav/intake/authority-manifest.json"), before = readFileSync(file, "utf8");
  put("src/permissions.ts", "export const allowed = true;");
  expect(() => verifyIntakeAuthoritySources(root)).toThrow();
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(() => writeIntakeAuthorityManifest("sav-intake-authority-fixture.v1", root)).toThrow();
  expect(readFileSync(file, "utf8")).toBe(before);
  writeIntakeAuthorityManifest("sav-intake-authority-fixture.v2", root);
  expect(() => verifyIntakeAuthoritySources(root)).not.toThrow();
});
