import { z } from "zod";
import { executionAdministrator } from "@/lib/sav/intake/execution-policy";
import { commercialAuthorityCommandSchema, previewCommercialDeliveryAuthority, commitCommercialDeliveryAuthority, getCommercialDeliveryAuthority } from "@/lib/sav/intake/commercial-delivery-authority";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const command = z.discriminatedUnion("operation", [commercialAuthorityCommandSchema.extend({ operation: z.literal("preview") }), z.object({ operation: z.literal("commit"), commandId: z.uuid(), hash: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true), reservedDispatchesUnderstood: z.literal(true) }).strict()]);
const error = (e: unknown) => Response.json({ error: e instanceof Error && /^SAV_[A-Z_]+$/.test(e.message) ? e.message : "invalid_request" }, { status: 409, headers });
async function admin() { try {
    await executionAdministrator();
    return true;
}
catch {
    return false;
} }
export async function GET() { if (!await admin())
    return Response.json({ error: "forbidden" }, { status: 403, headers }); try {
    return Response.json(await getCommercialDeliveryAuthority(), { headers });
}
catch (e) {
    return error(e);
} }
export async function POST(request: Request) {
    if (!await admin())
        return Response.json({ error: "forbidden" }, { status: 403, headers });
    if (request.headers.get("origin") !== new URL(request.url).origin)
        return Response.json({ error: "invalid_origin" }, { status: 403, headers });
    if (!request.headers.get("content-type")?.startsWith("application/json") || Number(request.headers.get("content-length") ?? "0") > 12000)
        return Response.json({ error: "invalid_request" }, { status: 400, headers });
    try {
        const text = await request.text();
        if (Buffer.byteLength(text, "utf8") > 12000)
            throw Error("invalid_request");
        const body = command.parse(JSON.parse(text));
        if (body.operation === "preview") {
            const { operation, ...input } = body;
            void operation;
            return Response.json({ preview: await previewCommercialDeliveryAuthority(input), current: await getCommercialDeliveryAuthority(), providerActions: 0, modelCalls: 0 }, { headers });
        }
        return Response.json({ receipt: await commitCommercialDeliveryAuthority(body.commandId, body.hash), providerActions: 0, modelCalls: 0 }, { headers });
    }
    catch (e) {
        return error(e);
    }
}
