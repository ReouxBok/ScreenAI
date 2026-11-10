import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import snapshot from "./ui-parity-actions.json";

// SAV-49: every server action is listed in the parity matrix. A new or removed
// export fails here until the matrix and this snapshot are updated together.
const src = path.resolve(__dirname, "../..");
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(path.join(dir, entry.name)) : /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path.join(dir, entry.name)] : []);

it("server actions match the parity matrix exactly", () => {
  const found: Record<string, string[]> = {};
  for (const file of walk(src)) {
    const text = readFileSync(file, "utf8");
    if (!/^\s*["']use server["']/.test(text)) continue;
    found[path.relative(src, file).split(path.sep).join("/")] = [...text.matchAll(/export\s+async\s+function\s+(\w+)\s*\(/g)].map(match => match[1]);
  }
  expect(found).toEqual(snapshot.files);
  expect(Object.values(found).flat()).toHaveLength(101);
});

// The guards recorded in the matrix are the real ones: the key actions check SAV staff first and
// the token lib keeps keys to their owner; manual Other has no action guard, its lib demands the operator.
const source = (file: string) => readFileSync(path.join(src, file), "utf8");
const bodyOf = (text: string, name: string) => text.slice(text.indexOf(`export async function ${name}(`)).split(/\nexport /)[0];
it("agent key actions require SAV console staff before any effect", () => {
  const text = source("app/studio/sav/intake/agents/actions.ts"), tokens = source("lib/mcp/tokens.ts");
  for (const name of snapshot.files["app/studio/sav/intake/agents/actions.ts"]) {
    const body = bodyOf(text, name);
    expect(body.indexOf("await requireIntakeConsoleStaff()")).toBeGreaterThan(-1);
    expect(body.indexOf("await requireIntakeConsoleStaff()")).toBeLessThan(body.search(/StudioMcpToken\(/));
  }
  expect(tokens).toContain(`throw Error("SAV_MCP_TOKEN_UNAUTHORIZED")`);
  expect(bodyOf(tokens, "revokeStudioMcpToken")).toContain("eq(studioMcpTokens.staffId, owner.id)");
  expect(snapshot.guards["app/studio/sav/intake/agents/actions.ts"].action).toBe("requireIntakeConsoleStaff()");
});
it("manual Other is guarded in its lib by the administrator and the operator check", () => {
  const action = source("app/studio/sav/intake/manual-other-actions.ts"), lib = source("lib/sav/external-completion.ts");
  expect(action).toContain("classifyValidSourceAsOther(");
  expect(source("lib/sav/intake/manual-other-classification.ts")).toMatch(/return classifySavDossierOtherManually\(/);
  const guarded = bodyOf(lib, "classifySavDossierOtherManually");
  expect(guarded).toMatch(/const actor = await executionAdministrator\(\);\s*assertOperator\(actor\.email\);/);
  expect(source("lib/sav/intake/execution-policy.ts")).toMatch(/\["admin", "owner"\]\.includes\(staff\.role\)/);
  expect(lib).toMatch(/function assertOperator\(actorEmail: string\) \{\n\s*if \(actorEmail\.toLowerCase\(\) !== "ugo@limova\.ai"\) throw/);
  expect(snapshot.guards["app/studio/sav/intake/manual-other-actions.ts"].action).toBeNull();
});
