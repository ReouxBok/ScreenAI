/*
 * SAV-92 harness, phase 1b: replay stored mails, stored cases or inline phrases for ONE block, with the real V2 decision path and NO EFFECT.
 * Usage (from studio/):
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/run-sav-block-replay.ts --input <file.json> --block <blockId> \
 *     --database-host <host> --out <private dir> [--model stub|live] [--budget-usd 2] [--mail-budget-usd 0.5]
 * <file.json>: { "blocks": SavBlockDraft[], "items": SavReplayItem[] } (items: { kind: "mail", messageId } | { kind: "case", caseId }
 *   | { kind: "phrase", text, subject?, requests?, attachments? }).
 * Reads the database named by DATABASE_URL, and only after `--database-host` repeats its host exactly (the target is never implicit).
 * Reads only: SELECT and decryption, plus the query embeddings of the existing knowledge search. Writes nothing to the database, sends
 * nothing, posts nothing. `--model live` calls the configured V2 Gemini model through the production transport, metered in memory only
 * (default cap 2 USD per run, at most 10 USD); the default `stub` makes no model call. Writes `replay-report.json` and `replay-summary.md`
 * (mode 600) into `--out`. Keep reports out of the repository: they may quote customer mails.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeDb } from "../src/db/client";
import type { SavBlockDraft } from "../src/lib/sav/blocks/block-attribution";
import type { SavReplayItem } from "../src/lib/sav/blocks/block-replay";
import { createSavReplayReadPorts } from "../src/lib/sav/blocks/block-replay-ports";
import { createSavReplayLiveModel } from "../src/lib/sav/blocks/replay-decision-live";
import { SAV_REPLAY_SPEND_LIMITS } from "../src/lib/sav/blocks/replay-decision";
import { runSavBlockReplayWithDecision } from "../src/lib/sav/blocks/replay-run";

const args = process.argv.slice(2);
const flag = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const fail = (message: string): never => { console.error(message); process.exit(2); };

const inputFile = flag("--input") ?? fail("--input <file.json> is required");
const blockId = flag("--block") ?? fail("--block <blockId> is required");
const out = flag("--out") ?? fail("--out <private directory> is required");
const model = flag("--model") ?? "stub";
if (model !== "stub" && model !== "live") fail("--model must be stub or live");
const number = (name: string) => { const raw = flag(name); if (raw === undefined) return undefined; const value = Number(raw); return Number.isFinite(value) && value > 0 ? value : fail(`${name} must be a positive number`); };
const runUsd = number("--budget-usd"), mailUsd = number("--mail-budget-usd");
if (runUsd !== undefined && runUsd > SAV_REPLAY_SPEND_LIMITS.maxRunUsd) fail(`--budget-usd is capped at ${SAV_REPLAY_SPEND_LIMITS.maxRunUsd} USD`);

let host: string;
try { host = new URL(process.env.DATABASE_URL ?? "").hostname; } catch { host = ""; }
if (!host) fail("DATABASE_URL is absent or unreadable");
if (flag("--database-host") !== host) fail("--database-host must repeat the host of DATABASE_URL exactly (explicit target)");

const input = JSON.parse(readFileSync(inputFile, "utf8")) as { blocks?: SavBlockDraft[]; items?: SavReplayItem[] };
if (!Array.isArray(input.blocks) || !Array.isArray(input.items)) fail("the input file must hold { blocks: [...], items: [...] }");

async function main() {
  const now = new Date();
  console.error(`sav-block-replay: block=${blockId} items=${input.items!.length} model=${model} database=${host}`);
  const result = await runSavBlockReplayWithDecision({
    blockId, blocks: input.blocks!, items: input.items!, now, ports: createSavReplayReadPorts({ now }),
    ...(model === "live" ? { model: createSavReplayLiveModel({ env: process.env }) } : {}),
    budget: { ...(runUsd !== undefined ? { runUsd } : {}), ...(mailUsd !== undefined ? { mailUsd } : {}) },
  });
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const json = path.join(out, "replay-report.json"), md = path.join(out, "replay-summary.md");
  writeFileSync(json, `${JSON.stringify({ blockId, model: result.model, transport: result.transport, at: now.toISOString(), database: host, spend: result.spend, report: result.report }, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(md, result.summary, { mode: 0o600 });
  chmodSync(json, 0o600); chmodSync(md, 0o600);
  console.log(JSON.stringify({ report: json, summary: md, items: result.report.totals.items, byOutcome: result.report.totals.byOutcome, spend: result.spend }, null, 2));
}

main().catch(error => { console.error(error instanceof Error ? error.message : "replay_failed"); process.exitCode = 1; }).finally(() => closeDb().catch(() => undefined));
