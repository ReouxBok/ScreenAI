import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkCommonSimulationReport } from "./simulation-report-common";

// The canonical common-1 r2 fixture (bytes produced by the generator on 19ef490, sha256 400f…907e) and B's invalid vectors derived from it,
// read from disk exactly as a reader would import them: no adaptation of the observations. Each vector must be refused with its own codes.
const fixtureBytes = readFileSync(new URL("./fixtures/syn-rehearsal-report.common-1.r2.json", import.meta.url));
const vectors = JSON.parse(readFileSync(new URL("./fixtures/syn-rehearsal-report.common-1.r2.invalid-vectors.json", import.meta.url), "utf8")) as {
  base: { sha256: string }; vectors: { id: string; ops: (["set", (string | number)[], unknown] | ["delete", (string | number)[]])[]; expectedErrors: string[] }[];
};
const fixture = () => JSON.parse(fixtureBytes.toString("utf8")) as Record<string, unknown>;
function apply(report: Record<string, unknown>, ops: (typeof vectors)["vectors"][number]["ops"]) {
  for (const [op, path, value] of ops) {
    let parent = report as Record<string | number, unknown>;
    for (const key of path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
    const last = path.at(-1)!;
    if (op === "set") parent[last] = value;
    else if (Array.isArray(parent)) parent.splice(last as number, 1);
    else delete parent[last];
  }
  return report;
}

describe("common-1 r2: the canonical SYN fixture and B's invalid vectors", () => {
  it("the fixture on disk is the generated one and passes B's reference check unchanged", () => {
    expect(createHash("sha256").update(fixtureBytes).digest("hex")).toBe("400f53265ef9258018ed711b66af790c98978eea75469b02d41ac1867c9f907e");
    expect(vectors.base.sha256).toBe("400f53265ef9258018ed711b66af790c98978eea75469b02d41ac1867c9f907e");
    expect(checkCommonSimulationReport(fixture())).toEqual({
      errors: [],
      verdicts: { "SYN-B01": "match", "SYN-B02": "refused_as_expected", "SYN-B03": "match", "SYN-B04": "match", "SYN-B05": "match", "SYN-B06": "match",
        "SYN-B07": "match", "SYN-B08": "mismatch", "SYN-B09": "not_comparable", "SYN-B10": "not_comparable" },
      doubleSendKeys: { "SYN-B01": [], "SYN-B02": [], "SYN-B03": [], "SYN-B04": [], "SYN-B05": [], "SYN-B06": [], "SYN-B07": [], "SYN-B08": [], "SYN-B09": [] },
    });
  });

  it.each(vectors.vectors.map(vector => [vector.id, vector] as const))("%s is refused with exactly its codes", (_, vector) => {
    expect(vector.expectedErrors.length).toBeGreaterThan(0);
    expect(checkCommonSimulationReport(apply(fixture(), vector.ops)).errors).toEqual(vector.expectedErrors);
  });
});
