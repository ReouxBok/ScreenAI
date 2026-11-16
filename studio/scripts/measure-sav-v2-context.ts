/*
 * K1 (12/11): measure the V2 decision context on a local fixture (synthetic case + export of cards), offline.
 * Usage (from studio/):
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/measure-sav-v2-context.ts src/lib/sav/cases/fixtures/syn-context-budget.v1.json
 * Options: --max-input-bytes N (default: the fixture's, else 26000); --structured-output on|off, --compact on|off and --thinking low|medium|high (SAV-92 flags). Prints JSON: fixed / case / cards bytes, per card, the 85 % target.
 * Reads only the given file; no database, network, model or secret. Keep private exports out of the repository.
 */
import { readFileSync } from "node:fs";
import { measureCaseContextFixture, type CaseContextFixture } from "../src/lib/sav/cases/investigation-context-measure";

const args = process.argv.slice(2);
const valued = new Set(["--max-input-bytes", "--structured-output", "--thinking", "--compact"]);
const file = args.find((arg, index) => !arg.startsWith("--") && !valued.has(args[index - 1] ?? ""));
if (!file) { console.error("Usage: measure-sav-v2-context.ts <fixture.json> [--max-input-bytes N]"); process.exit(2); }
const flag = args.indexOf("--max-input-bytes");
const fixture: unknown = JSON.parse(readFileSync(file, "utf8"));
// A bare export of cards (an array) or a full fixture ({ case, cards, maxInputBytes }).
const base: CaseContextFixture = Array.isArray(fixture) ? { cards: fixture as CaseContextFixture["cards"] } : fixture as CaseContextFixture;
const max = flag >= 0 ? Number(args[flag + 1]) : undefined;
if (max !== undefined && !(Number.isSafeInteger(max) && max > 0)) { console.error("--max-input-bytes must be a positive integer"); process.exit(2); }
// SAV-92 idée 3: measure as the V2 flags would send it. --structured-output on|off, --thinking low|medium|high (same strict values as the env).
const so = args.includes("--structured-output") ? args[args.indexOf("--structured-output") + 1] : "off";
const thinking = args.includes("--thinking") ? args[args.indexOf("--thinking") + 1] : undefined;
if (so !== "on" && so !== "off") { console.error("--structured-output must be on or off"); process.exit(2); }
if (thinking !== undefined && thinking !== "low" && thinking !== "medium" && thinking !== "high") { console.error("--thinking must be low, medium or high"); process.exit(2); }
const compact = args.includes("--compact") ? args[args.indexOf("--compact") + 1] : "off";
if (compact !== "on" && compact !== "off") { console.error("--compact must be on or off"); process.exit(2); }
console.log(JSON.stringify(measureCaseContextFixture(max ? { ...base, maxInputBytes: max } : base, { compact: compact === "on", structuredOutput: so === "on", thinkingLevel: thinking ?? null }), null, 2));
