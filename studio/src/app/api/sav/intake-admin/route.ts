import { z } from "zod";
import { previewIntakeLaunch, commitIntakeLaunch, revokeIntakeExecutionPolicy } from "@/lib/sav/intake/launch-admin";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const command=z.discriminatedUnion("operation",[
  z.object({operation:z.literal("preview"),commandId:z.uuid(),input:z.unknown()}).strict(),
  z.object({operation:z.literal("commit"),commandId:z.uuid(),hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  z.object({operation:z.literal("revoke"),policyId:z.uuid(),reason:z.string().min(10).max(2000)}).strict(),
]);
/** Same-origin administrator POST only; no provisioning or auth bypass. */
export async function POST(request:Request) {
  if(request.headers.get("origin")!==new URL(request.url).origin)return Response.json({error:"SAV_INTAKE_ADMIN_ORIGIN_REJECTED"},{status:403});
  if(request.headers.get("content-type")?.split(";")[0].trim().toLowerCase()!=="application/json")return Response.json({error:"SAV_INTAKE_ADMIN_JSON_REQUIRED"},{status:415});
  try {
    const reader=request.body?.getReader();
    if(!reader)return Response.json({error:"SAV_INTAKE_ADMIN_JSON_REQUIRED"},{status:400});
    const chunks:Uint8Array[]=[];let size=0;
    while(true) {
      const next=await reader.read();if(next.done)break;
      size+=next.value.length;
      if(size>20000){await reader.cancel();return Response.json({error:"SAV_INTAKE_ADMIN_INPUT_TOO_LARGE"},{status:413});}
      chunks.push(next.value);
    }
    const bytes=new Uint8Array(size);let offset=0;
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
    const parsed=command.parse(JSON.parse(text));
    const result=parsed.operation==="preview" ? await previewIntakeLaunch(parsed.commandId,parsed.input)
      :parsed.operation==="commit" ? await commitIntakeLaunch(parsed.commandId,parsed.hash)
      :await revokeIntakeExecutionPolicy(parsed.policyId,parsed.reason);
    return Response.json(result,{headers:{"Cache-Control":"no-store"}});
  } catch(error) {
    const code=error instanceof Error&&/^SAV_[A-Z_]+$/.test(error.message)?error.message:"SAV_INTAKE_ADMIN_INVALID_COMMAND";
    return Response.json({error:code},{status:code.includes("UNAUTHORIZED")?403:409,headers:{"Cache-Control":"no-store"}});
  }
}
