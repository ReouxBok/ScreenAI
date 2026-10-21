import { evaluationAdministrator } from "@/lib/sav/intake/server-auth";
import { evaluationConfig, assertEvaluationOrigin, readEvaluationBody, evaluationHash, evaluationBatchSchema } from "@/lib/sav/intake/server-contract";
import { runServerEvaluation } from "@/lib/sav/intake/server-runner";
import { readServerEvaluation } from "@/lib/sav/intake/server-ledger";

export const runtime = "nodejs";
export const maxDuration = 120;
const response = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
function failure(error: unknown) {
  const code = error instanceof Error && /^SAV_EVAL_[A-Z_]+$/.test(error.message) ? error.message : "SAV_EVAL_REQUEST_REJECTED";
  return response({ error: code }, code === "SAV_EVAL_DISABLED" ? 404 : code === "SAV_EVAL_UNAUTHORIZED" ? 403 : 400);
}
export async function POST(request: Request) {
  try {
    const config = evaluationConfig(process.env);
    assertEvaluationOrigin(request, config);
    const actor = await evaluationAdministrator();
    const raw = await readEvaluationBody(request);
    if (evaluationHash(raw) !== config.manifestHash) throw Error("SAV_EVAL_MANIFEST_REJECTED");
    const batch = evaluationBatchSchema.parse(JSON.parse(raw));
    if (batch.campaignId !== config.campaignId) throw Error("SAV_EVAL_MANIFEST_REJECTED");
    return response(await runServerEvaluation(batch, config, actor, request.signal));
  } catch (error) { return failure(error); }
}
export async function GET(request: Request) {
  try {
    const config = evaluationConfig(process.env);
    assertEvaluationOrigin(request, config);
    await evaluationAdministrator();
    return response(await readServerEvaluation(config));
  } catch (error) { return failure(error); }
}
