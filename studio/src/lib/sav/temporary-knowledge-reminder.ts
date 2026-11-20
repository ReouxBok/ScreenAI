import "server-only";
import { eq, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savSyncState } from "@/db/schema";
import { activeTemporaryKnowledge, type ActiveTemporaryKnowledge } from "@/lib/knowledge/temporary-incidents-read";
import { temporaryKnowledgeEnabled } from "@/lib/knowledge/temporary-knowledge";
import { formatParisDateTime } from "@/lib/paris-date";

const reminderKey = "sav-temporary-knowledge:v1:reminder";
const parisClock = new Intl.DateTimeFormat("fr-FR", {
  timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
});

export function temporaryKnowledgeReminderText(cards: readonly Pick<ActiveTemporaryKnowledge, "title" | "validUntil">[]) {
  if (!cards.length) return "Aucune information temporaire active.";
  const count = cards.length === 1 ? "1 information temporaire active" : `${cards.length} informations temporaires actives`;
  return [`${count} :`, ...cards.map(card => `- ${card.title} (fin le ${formatParisDateTime(card.validUntil)})`), "Garder ou retirer ?"].join("\n");
}

/** The regular V2 effects tick prepares one private preview per Paris day, during the 07:00 hour. */
export async function prepareDailyTemporaryKnowledgeReminder(now: Date, env: Readonly<Record<string, string | undefined>> = process.env) {
  if (!temporaryKnowledgeEnabled(env) || !Number.isFinite(now.getTime())) return "off";
  const parts = Object.fromEntries(parisClock.formatToParts(now).map(part => [part.type, part.value]));
  if (parts.hour !== "07") return "not_due";
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  return requireDb().transaction(async tx => {
    await tx.execute(sql`select set_config('statement_timeout','5s',true), set_config('lock_timeout','2s',true)`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${reminderKey}))`);
    const [previous] = await tx.select({ day: sql<string>`${savSyncState.cursor}::jsonb ->> 'day'` }).from(savSyncState).where(eq(savSyncState.key, reminderKey));
    if (previous?.day && previous.day >= day) return "already_prepared";
    const cards = await activeTemporaryKnowledge(now, [], { db: tx, env });
    const cursor = JSON.stringify({ day, preparedAt: now.toISOString(), text: temporaryKnowledgeReminderText(cards) });
    await tx.insert(savSyncState).values({ key: reminderKey, status: "prepared", cursor, updatedAt: now })
      .onConflictDoUpdate({ target: savSyncState.key, set: { status: "prepared", cursor, updatedAt: now } });
    return "prepared";
  });
}
