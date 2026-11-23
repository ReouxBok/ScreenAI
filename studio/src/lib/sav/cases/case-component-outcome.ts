// The durable, deduplicated outcome of a component (note, status) of a case execution, in its journal. Shared by the thread reply driver
// (`case-effect-driver.ts`) and the first mail of a ticket without thread (`threadless-effects.ts`), so both record the same ledger entry.
import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { savIntakeEffectJournal } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { executionJournal, type ExecutionTx } from "../intake/execution-store";

/** The execution lock held by the caller serializes these durable, deduplicated component outcomes. */
export async function recordCaseComponentOutcome(tx: ExecutionTx, executionId: string, component: "note" | "status", outcome: Record<string, string>) {
  const kind = `case_component_${component}`;
  const [last] = await tx.select({ payload: savIntakeEffectJournal.payloadCiphertext }).from(savIntakeEffectJournal)
    .where(and(eq(savIntakeEffectJournal.executionId, executionId), eq(savIntakeEffectJournal.kind, kind)))
    .orderBy(desc(savIntakeEffectJournal.createdAt), desc(savIntakeEffectJournal.id)).limit(1);
  const previous = last ? decryptSavPayload<Record<string, string>>(last.payload) : null;
  // Once queued, the linked execution and its ledger own the status outcome. A later
  // configuration refusal must not hide an already confirmed (or engaged) effect.
  if (component === "status" && previous?.executionId && !outcome.executionId) return;
  if (!previous || JSON.stringify(previous) !== JSON.stringify(outcome)) await executionJournal(tx, executionId, kind, outcome);
}
