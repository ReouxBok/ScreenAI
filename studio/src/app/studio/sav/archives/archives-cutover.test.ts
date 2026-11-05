import { sql } from "drizzle-orm";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../../test/sav-db";
import { savMailboxes, savMessages, savSyncState, savThreads } from "@/db/schema";

// Non-regression on a migrated database (synthetic rows only): the archive list is filtered by the V0 cutover row
// (savV0EligibleMessageFilter, unchanged, with its mailbox and date restriction). With that row inactive or absent,
// V0 dossiers are stored but cannot be listed: the page says the archives are unavailable, never that none exists
// (it used to say "none recorded"). No code path changes that row after activation; this does not claim it happens in production.
const state = vi.hoisted(() => ({ db: null as unknown, staff: vi.fn(), cutover: vi.fn() }));
vi.mock("@/db", () => ({ requireDb: () => state.db, getDb: () => state.db, isDatabaseConfigured: () => true }));
vi.mock("@/lib/sav/auth", () => ({ requireSavStaff: state.staff }));
vi.mock("@/lib/sav/cutover", async importOriginal => {
  const real = await importOriginal<typeof import("@/lib/sav/cutover")>();
  state.cutover.mockImplementation(real.getSavV0Cutover);
  return { ...real, getSavV0Cutover: state.cutover };
});
vi.mock("next/link", () => ({ default: (props: ComponentProps<"a">) => createElement("a", props) }));
import { encryptSavPayload } from "@/lib/sav/crypto";
import { listSavInbox } from "@/lib/sav/service";
import ArchivesPage from "./page";

let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
const cutover = (status: string) => ({ key: "sav-v0-cutover", status, cursor: JSON.stringify({ receivedAfter: "2026-01-01T00:00:00.000Z", mailboxEmail: "sav@example.com",
  intakeRecipient: "contact@limova.ai", deploymentSha: "0".repeat(40), activatedBy: "operateur@example.test" }) });
// Every read runs inside a READ ONLY transaction: any insert, update, delete or cache repair would fail there.
async function readOnly<T>(work: () => Promise<T>) {
  return fixture.db.transaction(async tx => {
    await tx.execute(sql`set transaction read only`);
    const previous = state.db; state.db = tx;
    try { return await work(); } finally { state.db = previous; }
  });
}
const render = () => readOnly(async () => renderToStaticMarkup(await ArchivesPage({ searchParams: Promise.resolve({}) })));

beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 60_000);
afterAll(async () => { await fixture?.client.close(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "test-only-sav-encryption-key-32-characters");
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); }));
  state.staff.mockReset(); state.staff.mockResolvedValue({ email: "operateur@example.test", role: "admin" }); state.cutover.mockClear();
  await fixture.client.exec("TRUNCATE sav.mailboxes CASCADE; DELETE FROM sav.sync_state WHERE key = 'sav-v0-cutover'");
  const [mailbox] = await fixture.db.insert(savMailboxes).values({ email: "sav@example.com" }).returning();
  const [other] = await fixture.db.insert(savMailboxes).values({ email: "autre@example.com" }).returning();
  for (const [box, subject, receivedAt] of [[mailbox, "Après la bascule", new Date("2026-06-01T10:00:00Z")], [mailbox, "Avant la bascule", new Date("2025-12-01T10:00:00Z")], [other, "Autre boîte", new Date("2026-06-01T10:00:00Z")]] as const) {
    const [thread] = await fixture.db.insert(savThreads).values({ mailboxId: box!.id, gmailThreadId: `g-${subject}`, customerEmail: "client@example.test", subject }).returning();
    await fixture.db.insert(savMessages).values({ mailboxId: box!.id, threadId: thread!.id, direction: "inbound", fromEmail: "client@example.test", subject,
      bodyCiphertext: encryptSavPayload({ text: "Question synthétique" }), receivedAt, processedAt: receivedAt, analysisStatus: "done" });
  }
});

describe("archives and the V0 cutover row", () => {
  it("active: only the cutover mailbox after the boundary is listed (historical restriction kept), without any write", async () => {
    await fixture.db.insert(savSyncState).values(cutover("active"));
    expect((await readOnly(() => listSavInbox(51, { offset: 0 }))).map(row => row.subject)).toEqual(["Après la bascule"]);
    const html = await render();
    expect(html).toContain("Après la bascule"); expect(html).not.toMatch(/Avant la bascule|Autre boîte|Archives non lisibles/);
  });
  for (const label of ["disabled", "absent"]) it(`${label}: the stored dossiers stay filtered out and the page says unavailable, never that none exists`, async () => {
    if (label !== "absent") await fixture.db.insert(savSyncState).values(cutover(label));
    // The global filter is unchanged: the reader itself still lists nothing outside an active cutover.
    expect(await readOnly(() => listSavInbox(51, { offset: 0 }))).toEqual([]);
    const html = await render();
    expect(html).toContain("Archives non lisibles"); expect(html).toContain("Ce n’est pas une liste vide");
    expect(html).not.toMatch(/Aucun dossier|Après la bascule/);
  });
  it("a refused role reads nothing, not even the cutover", async () => {
    await fixture.db.insert(savSyncState).values(cutover("active"));
    state.staff.mockRejectedValueOnce(Error("NEXT_REDIRECT"));
    await expect(render()).rejects.toThrow("NEXT_REDIRECT");
    expect(state.cutover).not.toHaveBeenCalled();
  });
  it("an unreadable cutover row is a failed read (error page), not an empty list", async () => {
    await fixture.db.insert(savSyncState).values({ ...cutover("active"), cursor: "{not json" });
    await expect(render()).rejects.toThrow();
  });
});
