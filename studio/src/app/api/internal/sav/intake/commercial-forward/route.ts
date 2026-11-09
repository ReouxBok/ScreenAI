import { z } from "zod";
import { executionAdministrator } from "@/lib/sav/intake/execution-policy";
import { prepareSavCommercialForward, queueSavCommercialForward } from "@/lib/sav/intake/commercial-forward";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const command = z.object({ token: z.string().min(1).max(180000), confirmed: z.literal(true), historyReviewed: z.literal(true) }).strict();
const error = (e: unknown) => Response.json({ error: e instanceof Error && /^SAV_[A-Z_]+$/.test(e.message) ? e.message : "invalid_request" }, { status: 409, headers });
async function admin() { try {
    await executionAdministrator();
    return true;
}
catch {
    return false;
} }
/** Read-only preview. No action is queued and no provider is called. */
export async function GET(request: Request) {
    if (!await admin())
        return Response.json({ error: "forbidden" }, { status: 403, headers });
    try {
        return Response.json({ preview: await prepareSavCommercialForward(z.uuid().parse(new URL(request.url).searchParams.get("threadId"))) }, { headers });
    }
    catch (e) {
        return error(e);
    }
}
/** Explicit confirmation queues one action for the existing guarded Gmail worker. */
export async function POST(request: Request) {
    if (!await admin())
        return Response.json({ error: "forbidden" }, { status: 403, headers });
    if (request.headers.get("origin") !== new URL(request.url).origin)
        return Response.json({ error: "invalid_origin" }, { status: 403, headers });
    if (!request.headers.get("content-type")?.startsWith("application/json") || Number(request.headers.get("content-length") ?? "0") > 190000)
        return Response.json({ error: "invalid_request" }, { status: 400, headers });
    try {
        const text = await request.text();
        if (Buffer.byteLength(text, "utf8") > 190000)
            throw Error("invalid_request");
        const body = command.parse(JSON.parse(text));
        return Response.json({ receipt: await queueSavCommercialForward(body.token), providerActions: 0, modelCalls: 0 }, { headers });
    }
    catch (e) {
        return error(e);
    }
}
