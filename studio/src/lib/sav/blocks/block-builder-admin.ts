import "server-only";
import { eq, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs, savSyncState } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { executionAdministrator } from "../intake/execution-policy";
import { emptySavBlockBrief, savBlockBriefSchema, savBlockBriefToDraft, validateSavBlockBrief, type SavBlockBrief } from "./block-brief";

const keyFor = (blockId: string) => `sav-block-builder.v1:${emptySavBlockBrief(blockId).blockId}`;
/** Reuses active admin/owner + SAV access checks; each entry point authorizes independently. */
export const savBlockBuilderAdministrator = () => executionAdministrator();
export async function readSavBlockBuilder(blockId: string): Promise<SavBlockBrief> {
  await savBlockBuilderAdministrator();
  const [row] = await requireDb().select().from(savSyncState).where(eq(savSyncState.key, keyFor(blockId))).limit(1);
  if (!row) return emptySavBlockBrief(blockId);
  const brief = savBlockBriefSchema.parse(decryptSavPayload(row.cursor!));
  if (brief.blockId !== blockId) throw Error("SAV_BLOCK_BUILDER_INVALID");
  return brief;
}
/** The only writes are encrypted sync_state and an audit entry in one transaction. */
export async function saveSavBlockBuilder(raw: unknown, prepare = false) {
  const staff = await savBlockBuilderAdministrator(), brief = savBlockBriefSchema.parse(raw);
  if (prepare && !validateSavBlockBrief(brief).ok) throw Error("SAV_BLOCK_BRIEF_INCOMPLETE");
  // Conversion is deliberately recomputed, never trusted from a submitted draft.
  if (prepare) savBlockBriefToDraft(brief);
  await requireDb().transaction(async tx => {
    const key = keyFor(brief.blockId);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    const values = { key, cursor: encryptSavPayload(brief), status: "draft", updatedAt: new Date() };
    await tx.insert(savSyncState).values(values).onConflictDoUpdate({ target: savSyncState.key, set: values });
    await tx.insert(auditLogs).values({ actorEmail: staff.email, action: "sav_block_builder_saved", entityType: "sav_block_builder", entityId: brief.blockId,
      technicalMetadata: { revision: "v1", prepared: prepare, mode: "off" } });
  });
}
