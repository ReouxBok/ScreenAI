import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readV2PipelineWiring, V2_PIPELINE_WIRING } from "./pipeline-wiring";

// The panel is only true if the sources agree. Three kinds of caller are told apart, from the import graph of THIS tree:
// - a production caller: a module reachable from a runtime entry (every non-test module under app/, workflows/ and proxy.ts, static or dynamic
//   imports followed) that names the entry point: the step is wired and the panel must say so;
// - an injectable entry point: a module that names it but no runtime entry reaches (a local/OFF runtime raccord of a pole): allowed, still dormant;
// - nothing: dormant or absent.
// Entries are over-approximated (all of app/), which can only make a caller look MORE wired, never less: no guard is relaxed.
const SRC = path.resolve(__dirname, "../../../..");
const isTest = (name: string) => /\.test\.tsx?$|\.fixture\.ts$/.test(name);
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? (name === "node_modules" ? [] : files(full)) : /\.(ts|tsx)$/.test(name) && !isTest(name) ? [full] : [];
});
const sources = new Map(files(SRC).map(file => [path.relative(SRC, file), readFileSync(file, "utf8")]));
const resolve = (from: string, spec: string): string | null => {
  const base = spec.startsWith("@/") ? spec.slice(2) : spec.startsWith(".") ? path.join(path.dirname(from), spec) : null;
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) if (sources.has(path.normalize(candidate))) return path.normalize(candidate);
  return null;
};
const importsOf = (file: string) => [...sources.get(file)!.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)].flatMap(m => resolve(file, m[1]!) ?? []);
const ENTRIES = [...sources.keys()].filter(file => file.startsWith("app/") || file.startsWith("workflows/") || file === "proxy.ts");
const reachable = (() => {
  const seen = new Set<string>(ENTRIES), queue = [...ENTRIES];
  while (queue.length) for (const next of importsOf(queue.pop()!)) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  return seen;
})();
const callers = (name: string, owners: readonly string[]) => [...sources].filter(([file, text]) => !owners.includes(file) && new RegExp(`\\b${name}\\b`).test(text)).map(([file]) => file).sort();
const classifyEntryPoint = (name: string, owners: readonly string[]) => {
  const all = callers(name, owners);
  return { production: all.filter(file => reachable.has(file)), injectable: all.filter(file => !reachable.has(file)) };
};

/** The modules that define each dormant step's entry points. A caller elsewhere is classified above. */
const DORMANT_ENTRY_POINTS: Record<string, Record<string, readonly string[]>> = {
  owner_admission: { v2OwnerAttributionAdapter: ["lib/sav/cases/owner-attribution.ts"], v2OwnerAttributionPort: ["lib/sav/cases/owner-attribution.ts"] },
};
const WIRED_ENTRY_POINTS: typeof DORMANT_ENTRY_POINTS = {
  investigation: { runCaseInvestigation: ["lib/sav/cases/investigation-runner.ts"] },
  proposal: { submitCaseReplyProposal: ["lib/sav/cases/case-reply-store.ts"], finalizeCaseReplyProposal: ["lib/sav/cases/case-reply-outbound.ts"] },
  validation: { decideCaseReply: ["lib/sav/cases/case-reply-store.ts", "lib/sav/cases/case-reply-outbound.ts"] },
  send: { enqueueApprovedCaseReply: ["lib/sav/cases/case-reply-store.ts"], createCaseEffectDriver: ["lib/sav/cases/case-effect-driver.ts"] },
  follow_up: { runDueJ2Pass: ["lib/sav/cases/timer-store.ts"], reconcileCaseJ2: ["lib/sav/cases/v2-j2-binding.ts"] },
};

describe("V2 wiring panel = what the sources wire (production caller vs injectable entry point)", () => {
  it("the graph is real: the V2 pages are entries and reach the domain modules they import; V1's pipeline is reached", () => {
    expect(ENTRIES).toContain("app/studio/sav/v2/[ticketId]/page.tsx");
    for (const file of ["lib/sav/cases/case-reply-registry.ts", "lib/sav/cases/case-store.ts", "lib/sav/intake/event-pipeline.ts", "lib/sav/cases/intake-boundary.ts"]) expect(reachable.has(file), file).toBe(true);
  });

  it("each wired step has a runtime caller", () => {
    expect(Object.keys(DORMANT_ENTRY_POINTS).sort()).toEqual(V2_PIPELINE_WIRING.filter(s => s.state !== "wired_behind_flag" && s.step !== "crm_note").map(s => s.step).sort());
    expect(V2_PIPELINE_WIRING.filter(s => s.state === "wired_behind_flag").map(s => s.step)).toEqual(["entry", ...Object.keys(WIRED_ENTRY_POINTS)]);
    for (const [step, points] of Object.entries(WIRED_ENTRY_POINTS)) for (const [name, owners] of Object.entries(points)) {
      expect(classifyEntryPoint(name, owners).production.length, step + ":" + name).toBeGreaterThan(0);
    }
  });

  it("no dormant step has a production caller; an injectable caller (unreached by any runtime entry) keeps it dormant", () => {
    for (const [step, points] of Object.entries(DORMANT_ENTRY_POINTS)) for (const [name, owners] of Object.entries(points)) {
      for (const owner of owners) expect(sources.get(owner), `${step}:${name} named in ${owner}`).toMatch(new RegExp(`\\b${name}\\b`));
      expect(classifyEntryPoint(name, owners).production, `${step}:${name}`).toEqual([]);
    }
  });

  it("the entry step is the one wired, and wired for real: V1's pipeline relays behind SAV_CASE_RECORDING=on and is reached from a runtime entry", () => {
    expect(sources.get("lib/sav/intake/event-pipeline.ts")).toMatch(/if \(env\.SAV_CASE_RECORDING !== "on"\) return;[\s\S]{0,200}recordCaseAfterConfirmedIntake/);
    expect(classifyEntryPoint("recordCaseAfterConfirmedIntake", ["lib/sav/cases/intake-boundary.ts"]).production).toEqual(["lib/sav/intake/event-pipeline.ts"]);
  });

  it("no V2 page, port or view imports a store writer, a runner, a driver or a provider; no server action or route exists under the V2 pages", () => {
    const v2 = [...sources].filter(([file]) => file.startsWith("app/studio/sav/v2/"));
    for (const [file, text] of v2) {
      expect(text, file).not.toMatch(/"use server"|submitCaseReplyProposal|decideCaseReply|revokeCaseReply|enqueueApprovedCaseReply|runCaseInvestigation|createCaseEffectDriver|executeIntakePass|transitionCaseOwner|appendCaseEvent|fetch\(/);
      expect(text, file).not.toMatch(/from "[^"]*(gmail|hubspot|provider|anthropic|openai|execution-adapters)[^"]*"/i);
    }
    expect(v2.some(([file]) => /route\.tsx?$/.test(file))).toBe(false);
    expect(existsSync(path.join(__dirname, "actions.ts"))).toBe(false);
  });

  it("flags read as the domain reads them: only the exact enabling value is on", () => {
    const flags = (env: Record<string, string>) => Object.fromEntries(readV2PipelineWiring(env).filter(r => r.flag).map(r => [r.step, r.flagLabel]));
    expect(flags({})).toEqual({ entry: "réglage désactivé sur cet environnement", send: "désactivé sur cet environnement" });
    expect(flags({ SAV_CASE_RECORDING: "on", SAV_CASE_EFFECTS: "supervised" })).toEqual({ entry: "réglage activé sur cet environnement", send: "mode supervisé demandé" });
    expect(flags({ SAV_CASE_RECORDING: "ON", SAV_CASE_EFFECTS: "auto" })).toEqual({ entry: "réglage désactivé sur cet environnement", send: "réglage non reconnu, traité comme désactivé" });
    expect(readV2PipelineWiring({}).map(r => r.stateLabel)).toEqual(["Branché", "Présent, non branché", "Branché", "Branché", "Branché", "Branché", "Branché", "Absent"]);
  });
});
