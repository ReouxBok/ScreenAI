/**
 * SAV-92 offline replay of the V1 noise filter. Read only: one READ ONLY transaction, SELECT only, no model,
 * no CRM, no Gmail, no write. Prints counts per view, verdict, rule and guard, plus the internal ids of the
 * mails that would leave "to_validate" (to review by hand). Never prints an address, subject, header value or text.
 *
 * Usage (from studio/, with the target database and its decryption key in the environment):
 *   NODE_OPTIONS=--conditions=react-server node_modules/.bin/tsx scripts/sav-noise-filter-replay.ts \
 *     [--mailbox <uuid>] [--limit <1..5000, default 500>] [--views other,to_validate]
 * Required environment: DATABASE_URL (prefer a read-only role) and SAV_ENCRYPTION_KEY_V1. No .env is loaded.
 */
async function main() {
  const args = process.argv.slice(2);
  if (args.length % 2) throw Error("SAV_NOISE_REPLAY_ARGUMENTS_REFUSED");
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--mailbox", "--limit", "--views"].includes(args[i]) || options.has(args[i])) throw Error("SAV_NOISE_REPLAY_ARGUMENTS_REFUSED");
    options.set(args[i], args[i + 1]);
  }
  const mailboxId = options.get("--mailbox");
  if (mailboxId && !/^[0-9a-f-]{36}$/i.test(mailboxId)) throw Error("SAV_NOISE_REPLAY_ARGUMENTS_REFUSED");
  const limit = options.has("--limit") ? Number(options.get("--limit")) : 500;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw Error("SAV_NOISE_REPLAY_ARGUMENTS_REFUSED");
  const views = (options.get("--views") ?? "other,to_validate").split(",");
  if (!process.env.DATABASE_URL || !process.env.SAV_ENCRYPTION_KEY_V1) throw Error("SAV_NOISE_REPLAY_ENVIRONMENT_REQUIRED");
  const { sql } = await import("drizzle-orm");
  const { requireDb, closeDb } = await import("../src/db");
  const { replaySavIntakeNoiseFilter } = await import("../src/lib/sav/intake/noise-filter-replay");
  try {
    const report = await requireDb().transaction(async tx => {
      await tx.execute(sql`set transaction read only`);
      return replaySavIntakeNoiseFilter(tx, { mailboxId, limit, views });
    });
    console.log(JSON.stringify(report, null, 2));
  } finally { await closeDb(); }
}
main().catch(error => {
  // Fixed codes only: never echo a row, a connection string or a key.
  console.error(error instanceof Error && /^SAV_NOISE_REPLAY_[A-Z_]+$/.test(error.message) ? error.message : "SAV_NOISE_REPLAY_FAILED");
  process.exit(1);
});
