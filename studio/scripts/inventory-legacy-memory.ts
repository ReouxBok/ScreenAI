import "dotenv/config";
import postgres from "postgres";
import { readLegacyMemoryInventory } from "../src/memory/inventory";

const url = process.env.MEMORY_DATABASE_URL;
if (!url || !/^postgres(?:ql)?:\/\//.test(url)) {
  console.error("MEMORY_INVENTORY_REQUIRES_POSTGRES_URL");
  process.exitCode = 1;
} else {
  const client = postgres(url, { max: 1, prepare: false, connect_timeout: 10, idle_timeout: 5 });
  try {
    const report = await client.begin("isolation level repeatable read read only", async transaction => {
      await transaction`SET LOCAL statement_timeout = '15s'`;
      await transaction`SET LOCAL lock_timeout = '2s'`;
      return readLegacyMemoryInventory(async statement => [...await transaction.unsafe(statement)]);
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.complete) process.exitCode = 2;
  } catch {
    console.error("MEMORY_INVENTORY_FAILED_NO_DATA_EXPORTED");
    process.exitCode = 1;
  } finally {
    await client.end({ timeout: 5 });
  }
}
