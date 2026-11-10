import { vi } from "vitest";

// Loaded only by the CI's native step (SAV_TEST_NATIVE_REQUIRED=1, vitest.config.mts): no test file may build a PGlite there, directly or
// through a helper, so a file that would silently run on PGlite instead of the native instance fails.
vi.mock("@electric-sql/pglite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@electric-sql/pglite")>()),
  PGlite: class { constructor() { throw new Error("SAV_NATIVE_TEST_PGLITE_REFUSED"); } },
}));
