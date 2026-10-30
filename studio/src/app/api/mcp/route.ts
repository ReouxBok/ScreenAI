import { handleStudioMcpRequest } from "@/lib/mcp/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const handle = (request: Request) => handleStudioMcpRequest(request);
export { handle as GET, handle as POST, handle as DELETE, handle as OPTIONS };
