/**
 * SAV-16 local daily review CLI. Reads a pre-collected JSON file (no DB, no network, no secret),
 * validates it strictly and writes either a private 0600 report or sanitized text on stdout.
 * Usage: node_modules/.bin/tsx scripts/sav-daily-review.ts <input.json> [--out <report.json>]
 */
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { buildDailyReview, renderDailyReview } from "../src/lib/sav/daily-review";

const [file, flag, out] = process.argv.slice(2);
if (!file || (flag && (flag !== "--out" || !out))) { console.error("usage: sav-daily-review <input.json> [--out <report.json>]"); process.exit(2); }
try {
  const raw = readFileSync(file, "utf8");
  if (raw.length > 2_000_000) throw Error("DAILY_REVIEW_INPUT_TOO_LARGE");
  const review = buildDailyReview(JSON.parse(raw));
  if (out) { writeFileSync(out, JSON.stringify(review, null, 2), { mode: 0o600 }); chmodSync(out, 0o600); }
  console.log(renderDailyReview(review));
} catch (e) {
  // Never echo input content: only a fixed code.
  console.error(e instanceof Error && /^DAILY_REVIEW_[A-Z_]+$/.test(e.message) ? e.message : "DAILY_REVIEW_INPUT_INVALID");
  process.exit(1);
}
