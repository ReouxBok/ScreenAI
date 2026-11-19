import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { importGraph as graphOf } from "./smart-import-graph.testkit";

/*
 * Agent SAV intelligent (20/11), Astra's correction: « un contrôle des seuls imports directs laisserait passer un appel indirect ». This test walks
 * the WHOLE import graph of the new agent's entry points (static imports, re-exports AND dynamic `import()`, recursively, through `@/` and
 * relative paths) and refuses any module of an effect: V2's effect circuit and reply passage, V1's executor and effects, Gmail and HubSpot
 * writers, Slack, the case store and relay, the V2 launcher. Type-only imports are erased at runtime and skipped.
 */

const here = path.dirname(fileURLToPath(import.meta.url)), src = path.resolve(here, "../../../..");
const ENTRY_POINTS = readdirSync(here).filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".fixture.ts") && !name.endsWith(".testkit.ts")).map(name => path.join(here, name));

/** Modules that write to a customer, a ticket, Slack, a case or a queue, or launch V2. Paths relative to `src/`. */
const FORBIDDEN: readonly RegExp[] = [
  /^lib\/sav\/cases\/case-effect/, /^lib\/sav\/cases\/case-effects/, /^lib\/sav\/cases\/investigation-reply-passage/, /^lib\/sav\/cases\/case-handoff-(?:slack|notice)/,
  /^lib\/sav\/cases\/block-auto-reply/, /^lib\/sav\/cases\/j2-auto-reminder/, /^lib\/sav\/cases\/case-reply-(?:store|validation|review)/, /^lib\/sav\/cases\/case-store/,
  /^lib\/sav\/cases\/intake-boundary/, /^lib\/sav\/cases\/v2-entry\.ts$/, /^lib\/sav\/cases\/investigation-runner\.ts$/, /^lib\/sav\/cases\/owner-handover\.ts$/,
  /^lib\/sav\/intake\/executor/, /^lib\/sav\/intake\/effect/, /^lib\/sav\/gmail\.ts$/, /^lib\/sav\/hubspot\.ts$/, /^lib\/sav\/hubspot-transport/, /^lib\/sav\/gmail-permissions/,
  /slack/i, /^lib\/sav\/dispatch\.ts$/, /^lib\/sav\/followups/,
];

const importGraph = (entry: string) => graphOf(entry, src);
/**
 * The bench's CURRENT agent replays V2's decision through the production runner on in-memory ports (`blocks/replay-decision.ts`, SAV-92): it
 * reaches `investigation-runner.ts` and, through `investigation-intent.ts`, `case-effects.ts` and `case-handoff-notice.ts` (pure builders). They are admitted ONLY on that
 * path, and only while they stay pure: no database, no network, no other forbidden module (checked below).
 */
const PURE_ON_REPLAY_PATH = ["lib/sav/cases/investigation-runner.ts", "lib/sav/cases/case-effects.ts", "lib/sav/cases/case-handoff-notice.ts"];
const viaReplay = (chain: readonly string[]) => chain.some(step => path.relative(src, step).split(path.sep).join("/") === "lib/sav/blocks/replay-decision.ts");

describe("graphe d'imports du nouvel agent : aucun effet, même indirect", () => {
  it("chaque point d'entrée de smart/ (shadow, banc, auto-test) n'atteint aucun module d'effet", () => {
    expect(ENTRY_POINTS.map(file => path.basename(file))).toEqual(expect.arrayContaining(["smart-shadow.ts", "smart-agent.ts", "smart-bench-agent.ts", "smart-bench-selftest.ts"]));
    const offences: string[] = [];
    for (const entry of ENTRY_POINTS) for (const [file, chain] of importGraph(entry)) {
      const rel = path.relative(src, file).split(path.sep).join("/");
      if (PURE_ON_REPLAY_PATH.includes(rel) && viaReplay(chain)) continue;
      if (FORBIDDEN.some(pattern => pattern.test(rel))) offences.push(chain.map(step => path.relative(src, step)).join(" -> "));
    }
    expect(offences).toEqual([]);
  });
  it("les modules admis sur le chemin du rejeu restent purs (ni base, ni réseau)", () => {
    for (const rel of PURE_ON_REPLAY_PATH) {
      const source = readFileSync(path.join(src, rel), "utf8");
      expect(source).not.toMatch(/from "@\/db"|requireDb|\bfetch\(|import "server-only"/);
    }
    expect(readFileSync(path.join(src, "lib/sav/cases/investigation-runner.ts"), "utf8")).toContain("export const SAV_CASE_INVESTIGATION_MAX_CALLS = 3;");
  });
  it("le parcours suit les imports indirects et dynamiques (contrôle du test lui-même)", () => {
    const graph = [...importGraph(path.join(here, "smart-shadow.ts")).keys()].map(file => path.relative(src, file).split(path.sep).join("/"));
    // Indirect: smart-shadow -> smart-model -> access-skill-judge -> investigation-v2-providers.
    expect(graph).toContain("lib/sav/cases/investigation-v2-providers.ts");
    // A known effect module IS caught when reachable: the reconcile pass reaches Gmail's writer.
    const reconcile = [...importGraph(path.join(src, "lib/sav/reconcile-pass.ts")).keys()].map(file => path.relative(src, file).split(path.sep).join("/"));
    expect(reconcile).toContain("lib/sav/gmail.ts");
    expect(reconcile).toContain("lib/sav/cases/smart/smart-shadow.ts");
  });
});
