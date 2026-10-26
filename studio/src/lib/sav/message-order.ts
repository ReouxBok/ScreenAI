import { sql } from "drizzle-orm";
import { savMessages } from "@/db/schema";

/** A provider date later than local storage (clock skew, imported mail) is
 * bounded by storage time wherever messages are ordered or "the latest" is
 * chosen. The raw received_at stays on the row and in source hashes. */
export const savEffectiveReceivedAt = sql`least(${savMessages.receivedAt}, ${savMessages.createdAt})`.mapWith(savMessages.receivedAt);
/** The same bound for a raw SQL alias of sav.messages, e.g. `m` → least(m.received_at, m.created_at). */
export const savEffectiveReceivedAtOf = (alias: string) => {
  if (!/^[a-z_][a-z0-9_]{0,30}$/.test(alias)) throw Error("SAV_MESSAGE_ALIAS_INVALID");
  return `least(${alias}.received_at, ${alias}.created_at)`;
};
/** Row-level counterpart of savEffectiveReceivedAt; without a storage time the raw date is kept. */
export function savEffectiveReceivedAtOfRow(row: { receivedAt: Date; createdAt?: Date }) {
  return row.createdAt && row.receivedAt.getTime() > row.createdAt.getTime() ? row.createdAt : row.receivedAt;
}
