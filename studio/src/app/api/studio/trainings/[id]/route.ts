import { NextResponse } from "next/server";
import { requireApiStaff } from "@/lib/auth";
import { compactTrainingEvents } from "@/lib/training-events";
import { getManageableTraining } from "@/lib/training";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const staff = await requireApiStaff();
    const { id } = await context.params;
    const detail = await getManageableTraining(id, staff);
    if (!detail) return NextResponse.json({ error: "Démonstration introuvable" }, { status: 404 });

    const events = compactTrainingEvents(detail.events).map((event) => ({
      id: event.id,
      ordinal: event.ordinal,
      kind: event.kind,
      path: event.path,
      label: event.label,
      payload: {
        controlType: event.payload.controlType ?? null,
        section: event.payload.section ?? null,
        testId: event.payload.testId ?? null,
        elementId: event.payload.elementId ?? null,
        role: event.payload.role ?? null,
      },
    }));

    return NextResponse.json({
      session: {
        id: detail.session.id,
        status: detail.session.status,
        contentItemId: detail.session.contentItemId,
        recordingStatus: detail.session.recordingStatus,
        recordingPathname: detail.session.recordingPathname ? "available" : null,
        recordingSizeBytes: detail.session.recordingSizeBytes,
        recordingDurationMs: detail.session.recordingDurationMs,
        recordingUploadedAt: detail.session.recordingUploadedAt?.toISOString() ?? null,
      },
      events,
      rawEventCount: detail.events.length,
      revision: detail.session.updatedAt.toISOString(),
    }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  }
}
