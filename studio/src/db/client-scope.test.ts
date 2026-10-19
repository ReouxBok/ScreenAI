import { afterEach, expect, it, vi } from "vitest";
import { getDb, withStudioDatabase } from "./client";
afterEach(() => vi.unstubAllEnvs());
it("isolates concurrent request DB contexts and restores the normal pool afterwards", async () => {
  vi.stubEnv("DATABASE_URL", "");
  const first = { marker: "first" } as unknown as NonNullable<ReturnType<typeof getDb>>;
  const second = { marker: "second" } as unknown as NonNullable<ReturnType<typeof getDb>>;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const a = withStudioDatabase(first, async () => { await held; expect(getDb()).toBe(first); });
  await withStudioDatabase(second, async () => { expect(getDb()).toBe(second); release(); await a; expect(getDb()).toBe(second); });
  expect(getDb()).toBeNull();
});
