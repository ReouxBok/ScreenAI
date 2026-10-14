type InventoryQuery = (statement: string) => Promise<Record<string, unknown>[]>;

const tables = [
  ["copilot_users", "identity_key", "profile_ciphertext"],
  ["conversation_sessions", "user_key", "adk_state_ciphertext"],
  ["conversation_messages", "user_key", "ciphertext"],
  ["conversation_summaries", "user_key", "ciphertext"],
  ["copilot_memories", "user_key", "ciphertext"],
  ["copilot_goals", "user_key", "title_ciphertext", "next_step_ciphertext", "blocker_ciphertext"],
  ["memory_tombstones", "user_key"],
  ["copilot_runs", "user_key", "state_ciphertext"],
  ["memory_audit_events", "user_key"],
] as const;

function count(value: unknown): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error("INVALID_INVENTORY_COUNT");
  return value;
}

export async function readLegacyMemoryInventory(query: InventoryQuery) {
  const inventory: Record<string, { present: boolean; rows?: string; identities?: string; ciphertextBytes?: string }> = {};
  for (const [table, identity, ...encrypted] of tables) {
    const [presence] = await query(`SELECT to_regclass('charly_memory.${table}') IS NOT NULL AS present`);
    if (presence?.present !== true) {
      inventory[table] = { present: false };
      continue;
    }
    const bytes = encrypted.length ? encrypted.map(column => `coalesce(octet_length(${column}), 0)`).join(" + ") : "0";
    const [row] = await query(`SELECT count(*)::text AS rows, count(DISTINCT ${identity})::text AS identities, coalesce(sum(${bytes}), 0)::text AS ciphertext_bytes FROM charly_memory.${table}`);
    inventory[table] = { present: true, rows: count(row?.rows), identities: count(row?.identities), ciphertextBytes: count(row?.ciphertext_bytes) };
  }
  const complete = Object.values(inventory).every(table => table.present);
  let eligibility = null;
  if (complete) {
    const [row] = await query(`SELECT
      (SELECT count(*)::text FROM charly_memory.copilot_users WHERE memory_enabled = false) AS disabled_users,
      (SELECT count(*)::text FROM charly_memory.copilot_memories WHERE status = 'active' AND (expires_at IS NULL OR expires_at > now())) AS active_memories,
      (SELECT count(*)::text FROM charly_memory.copilot_memories WHERE expires_at <= now()) AS expired_memories,
      (SELECT count(*)::text FROM charly_memory.copilot_runs WHERE status = 'active' AND expires_at > now()) AS active_runs,
      (SELECT count(*)::text FROM charly_memory.memory_tombstones WHERE expires_at IS NULL OR expires_at > now()) AS effective_tombstones`);
    eligibility = { disabledUsers: count(row?.disabled_users), activeMemories: count(row?.active_memories), expiredMemories: count(row?.expired_memories), activeRuns: count(row?.active_runs), effectiveTombstones: count(row?.effective_tombstones) };
  }
  return { schemaVersion: 1, source: "charly_memory", checkedAt: new Date().toISOString(), complete,
    identityMapping: "unverified", contentDecrypted: false, tables: inventory, eligibility };
}
