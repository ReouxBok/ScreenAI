import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { requireSavApiStaff } from "@/lib/sav/auth";
import { requireDb } from "@/db";
import { auditLogs, savActions, savThreads } from "@/db/schema";

export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireSavApiStaff("admin");
  const parsed = z.uuid().safeParse((await params).id);
  if (!parsed.success) return Response.json({ error:"invalid_request" },{ status:400 });
  const id = parsed.data, db = requireDb();
  const [thread] = await db.select({ ticketId:savThreads.hubspotTicketId }).from(savThreads).where(eq(savThreads.id,id)).limit(1);
  if (!thread) return Response.json({ error:"not_found" },{ status:404 });
  const refreshId = new URL(request.url).searchParams.get("refreshId");
  if (refreshId && !z.uuid().safeParse(refreshId).success) return Response.json({ error:"invalid_request" },{ status:400 });
  const [actions,refresh] = await Promise.all([
    db.select({ id:savActions.id,status:savActions.status,errorCode:savActions.errorCode }).from(savActions).where(and(eq(savActions.threadId,id),eq(savActions.actorType,"human"),inArray(savActions.kind,["create_ticket","link_ticket"]))).orderBy(desc(savActions.createdAt),desc(savActions.id)).limit(1),
    refreshId ? db.select({ action:auditLogs.action }).from(auditLogs).where(and(eq(auditLogs.entityType,"sav_context_refresh"),eq(auditLogs.entityId,refreshId),sql`${auditLogs.technicalMetadata}->>'threadId' = ${id}`)).orderBy(desc(auditLogs.createdAt)).limit(1) : Promise.resolve([]),
  ]);
  return Response.json({ ticket:actions[0] ?? null,ticketId:thread.ticketId,context:refresh[0]?.action === "sav_context_refresh_completed" ? "completed" : refresh[0]?.action === "sav_context_refresh_failed" ? "failed" : refresh.length ? "pending" : null },{ headers:{ "Cache-Control":"private, no-store" } });
}
