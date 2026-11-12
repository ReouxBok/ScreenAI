/*
 * K1 (12/11): measure the V2 decision context on a local fixture (synthetic case + export of cards), offline.
 * Usage (from studio/):
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/measure-sav-v2-context.ts src/lib/sav/cases/fixtures/syn-context-budget.v1.json
 * Options: --max-input-bytes N (default: the fixture's, else 26000). Prints JSON: fixed / case / cards bytes, per card, the 85 % target.
 * Reads only the given file; no database, network, model or secret. Keep private exports out of the repository.
 */
import { readFileSync } from "node:fs";
import { measureCaseContextFixture, type CaseContextFixture } from "../src/lib/sav/cases/investigation-context-measure";

const args = process.argv.slice(2);
const file = args.find(arg => !arg.startsWith("--"));
if (!file) { console.error("Usage: measure-sav-v2-context.ts <fixture.json> [--max-input-bytes N]"); process.exit(2); }
const flag = args.indexOf("--max-input-bytes");
const fixture: unknown = JSON.parse(readFileSync(file, "utf8"));
// A bare export of cards (an array) or a full fixture ({ case, cards, maxInputBytes }).
const base: CaseContextFixture = Array.isArray(fixture) ? { cards: fixture as CaseContextFixture["cards"] } : fixture as CaseContextFixture;
const max = flag >= 0 ? Number(args[flag + 1]) : undefined;
if (max !== undefined && !(Number.isSafeInteger(max) && max > 0)) { console.error("--max-input-bytes must be a positive integer"); process.exit(2); }
console.log(JSON.stringify(measureCaseContextFixture(max ? { ...base, maxInputBytes: max } : base), null, 2));
