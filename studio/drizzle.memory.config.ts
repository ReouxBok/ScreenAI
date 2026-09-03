import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/memory/schema.ts",
  out: "./memory-drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.MEMORY_DATABASE_URL ?? "postgresql://unused:unused@localhost/unused" },
  strict: true,
});
