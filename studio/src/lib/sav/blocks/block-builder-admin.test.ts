import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { auditLogs, savSyncState } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { emptySavBlockBrief, savBlockBriefSchema } from "./block-brief";
import { SAV_BLOCK_LESSONS } from "./lesson-controls";

const state = vi.hoisted(() => ({ authorized: true, writes: [] as { table: unknown; values: Record<string, unknown> }[], rows: [] as { cursor: string }[], dbCalls: 0 }));
vi.mock("../intake/execution-policy", () => ({ executionAdministrator: async () => {
  if (!state.authorized) throw Error("SAV_INTAKE_EXECUTION_UNAUTHORIZED");
  return { email: "synthetic-admin@example.invalid" };
} }));
vi.mock("@/db", () => ({ requireDb: () => {
  state.dbCalls++;
  return {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => state.rows }) }) }),
    transaction: async (fn: (tx: unknown) => Promise<void>) => fn({
      execute: async () => {},
      insert: (table: unknown) => {
        if (table !== savSyncState && table !== auditLogs) throw Error("FORBIDDEN_TABLE");
        return { values: (values: Record<string, unknown>) => {
          state.writes.push({ table, values });
          return { onConflictDoUpdate: async () => {} };
        } };
      },
    }),
  };
} }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw Error(`REDIRECT:${url}`); } }));
import { readSavBlockBuilder, saveSavBlockBuilder } from "./block-builder-admin";
import Page from "@/app/studio/sav/blocs/assistant/page";
import { saveBlockBriefAction } from "@/app/studio/sav/blocs/assistant/actions";

beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-builder-encryption-key-for-tests");
  state.authorized = true; state.writes = []; state.rows = []; state.dbCalls = 0;
});
it("rejects unauthorized page, action, reader and saver before any database access", async () => {
  state.authorized = false;
  for (const call of [() => Page({ searchParams: Promise.resolve({}) }), () => saveBlockBriefAction(new FormData()), () => readSavBlockBuilder("synthetic-block"), () => saveSavBlockBuilder(emptySavBlockBrief("synthetic-block"))])
    await expect(call()).rejects.toThrow("SAV_INTAKE_EXECUTION_UNAUTHORIZED");
  expect(state.dbCalls).toBe(0); expect(state.writes).toEqual([]);
});
it("writes only sync_state and auditLogs and encrypts all brief contents", async () => {
  const brief = { ...emptySavBlockBrief("synthetic-block"), objective: "Objectif synthétique confidentiel" };
  await saveSavBlockBuilder(brief);
  expect(state.writes.map(row => row.table)).toEqual([savSyncState, auditLogs]);
  const values = state.writes[0].values;
  expect(values).toMatchObject({ key: "sav-block-builder.v1:synthetic-block", status: "draft" });
  expect(values.cursor).not.toContain(brief.objective);
  expect(decryptSavPayload(String(values.cursor))).toEqual(brief);
  expect(state.writes[1].values).toMatchObject({ action: "sav_block_builder_saved", technicalMetadata: { mode: "off", prepared: false, revision: "v1" } });
  expect(JSON.stringify(state.writes[1].values)).not.toContain(brief.objective);
});
it("reads encrypted briefs, defaults absent rows to off and rejects corrupt or cross-block contents", async () => {
  expect(await readSavBlockBuilder("synthetic-block")).toEqual(emptySavBlockBrief("synthetic-block"));
  const brief = emptySavBlockBrief("synthetic-block"); state.rows = [{ cursor: encryptSavPayload(brief) }];
  expect(await readSavBlockBuilder("synthetic-block")).toEqual(brief);
  await expect(readSavBlockBuilder("another-block")).rejects.toThrow("SAV_BLOCK_BUILDER_INVALID");
  state.rows = [{ cursor: "corrupt" }]; await expect(readSavBlockBuilder("synthetic-block")).rejects.toThrow();
});
it("blocks direct preparation with any missing lesson, and refuses injected live settings without writes", async () => {
  for (const raw of [emptySavBlockBrief("synthetic-block"), { ...emptySavBlockBrief("synthetic-block"), mode: "automatic" }])
    await expect(saveSavBlockBuilder(raw, true)).rejects.toThrow();
  expect(state.writes).toEqual([]);
});
it("prepares a complete brief using only the two allowed tables", async () => {
  const brief = savBlockBriefSchema.parse({ ...emptySavBlockBrief("synthetic-block"), objective: "Procédure de démonstration", examples: ["Exemple synthétique"], exclusions: ["Hors périmètre"], neighbours: ["autre-bloc"], humanOnly: ["Validation humaine"], transferTo: "Support", resolutionProof: "Résultat visible vérifié", lessons: Object.fromEntries(SAV_BLOCK_LESSONS.map(row => [row.id, { confirmed: true, plan: "Vérifier avec un test synthétique" }])) });
  await saveSavBlockBuilder(brief, true);
  expect(state.writes.map(row => row.table)).toEqual([savSyncState, auditLogs]);
  expect(state.writes[1].values.technicalMetadata).toMatchObject({ prepared: true, mode: "off" });
});
it("a forged prepare action saves incomplete work but redirects to blocked", async () => {
  const form = new FormData(); form.set("blockId", "synthetic-block"); form.set("intent", "prepare");
  await expect(saveBlockBriefAction(form)).rejects.toThrow("result=blocked");
  expect(state.writes[1].values.technicalMetadata).toMatchObject({ prepared: false });
});
it("page uses the administrator boundary and server action without client or API transport", () => {
  const page = readFileSync(new URL("../../../app/studio/sav/blocs/assistant/page.tsx", import.meta.url), "utf8");
  expect(page).toContain("await savBlockBuilderAdministrator()");
  expect(page).toContain("action={saveBlockBriefAction}");
  expect(page).not.toMatch(/use client|fetch\(|\/api\//);
});
