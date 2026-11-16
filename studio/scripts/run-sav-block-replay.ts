/*
 * SAV-92 harness, phase 1b: replay stored mails, stored cases or inline phrases for ONE block, with the real V2 decision path and NO EFFECT.
 * Usage (from studio/):
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/run-sav-block-replay.ts --input <file.json> --block <blockId> \
 *     --database-host <host> --database-port <port> --database-name <name> --out <private dir> [--model stub|live] [--budget-usd 2] \
 *     [--mail-budget-usd 0.5] [--scope <scopes.json>]
 * <file.json>: { "blocks": SavBlockDraft[], "items": SavReplayItem[] } (items: { kind: "mail", messageId } | { kind: "case", caseId }
 *   | { kind: "phrase", text, subject?, requests?, attachments? }).
 * Reads the database named by DATABASE_URL, and only after `--database-host`, `--database-port` (5432 when the URL names none) and
 * `--database-name` repeat it exactly (the target is never implicit). The replay opens its OWN connection, read only from its first statement
 * (`default_transaction_read_only=on`, checked on the server): Postgres refuses any write. `--scope <scopes.json>`: the approved block scopes,
 * as production configures them ({ "policyRevision", "access"?, "blocks"? }); without it, the block draft is converted to a scope (said in the summary).
 * Reads only: SELECT and decryption, plus the query embeddings of the existing knowledge search (counted, estimated, in the run cap). Writes nothing to the database, sends
 * nothing, posts nothing. `--model live` calls the configured V2 Gemini model through the production transport, metered in memory only
 * (default cap 2 USD per run, at most 10 USD); the default `stub` makes no model call. Writes `replay-report.json` and `replay-summary.md`
 * (mode 600) into `--out`. Keep reports out of the repository: they may quote customer mails.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeDb, withStudioDatabase } from "../src/db/client";
import type { SavBlockDraft } from "../src/lib/sav/blocks/block-attribution";
import type { SavReplayItem } from "../src/lib/sav/blocks/block-replay";
import { createSavReplayReadPorts } from "../src/lib/sav/blocks/block-replay-ports";
import { createSavReplayLiveModel } from "../src/lib/sav/blocks/replay-decision-live";
import { SAV_REPLAY_SPEND_LIMITS, type SavReplayApprovedScopes } from "../src/lib/sav/blocks/replay-decision";
import { openSavReplayReadOnlyDatabase, savReplayDatabaseTarget } from "../src/lib/sav/blocks/replay-database";
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

const checked = savReplayDatabaseTarget(process.env.DATABASE_URL, { host: flag("--database-host"), port: flag("--database-port"), database: flag("--database-name") });
if (!checked.ok) fail(`${checked.problem}: --database-host, --database-port and --database-name must repeat DATABASE_URL exactly (explicit target)`);
const target = checked.ok ? checked.target : fail("unreachable");
const database = `${target.host}:${target.port}/${target.database}`;
const scopeFile = flag("--scope");
const scopes = scopeFile ? JSON.parse(readFileSync(scopeFile, "utf8")) as SavReplayApprovedScopes : undefined;
if (scopes && (typeof scopes.policyRevision !== "string" || !scopes.policyRevision)) fail("--scope: the file must hold { policyRevision, access?, blocks? }");

const input = JSON.parse(readFileSync(inputFile, "utf8")) as { blocks?: SavBlockDraft[]; items?: SavReplayItem[] };
if (!Array.isArray(input.blocks) || !Array.isArray(input.items)) fail("the input file must hold { blocks: [...], items: [...] }");

async function main() {
  const now = new Date();
  console.error(`sav-block-replay: block=${blockId} items=${input.items!.length} model=${model} database=${database} scope=${scopes ? "approved" : "draft"}`);
  const readOnly = await openSavReplayReadOnlyDatabase(process.env.DATABASE_URL!, target);
  // Every read of the replay goes through this read-only connection (request-local database), never the shared pool.
  const result = await withStudioDatabase(readOnly.db, () => runSavBlockReplayWithDecision({
    blockId, blocks: input.blocks!, items: input.items!, now, ports: createSavReplayReadPorts({ now }),
    ...(model === "live" ? { model: createSavReplayLiveModel({ env: process.env }) } : {}),
    budget: { ...(runUsd !== undefined ? { runUsd } : {}), ...(mailUsd !== undefined ? { mailUsd } : {}) },
    ...(scopes ? { scopes } : {}),
  })).finally(() => readOnly.close().catch(() => undefined));
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const json = path.join(out, "replay-report.json"), md = path.join(out, "replay-summary.md");
  writeFileSync(json, `${JSON.stringify({ blockId, model: result.model, transport: result.transport, at: now.toISOString(), database, readOnly: true, scope: scopes ? "approved" : "draft", spend: result.spend, report: result.report }, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(md, result.summary, { mode: 0o600 });
  chmodSync(json, 0o600); chmodSync(md, 0o600);
  console.log(JSON.stringify({ report: json, summary: md, items: result.report.totals.items, byOutcome: result.report.totals.byOutcome, spend: result.spend }, null, 2));
}

main().catch(error => { console.error(error instanceof Error ? error.message : "replay_failed"); process.exitCode = 1; }).finally(() => closeDb().catch(() => undefined));
