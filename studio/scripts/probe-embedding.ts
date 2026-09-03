import "dotenv/config";
import { closeDb } from "../src/db/client";
import { embeddingFailureDiagnostic, GEMINI_EMBEDDING_MODEL, probeEmbedding } from "../src/lib/embeddings";

const startedAt = performance.now();

try {
  const result = await probeEmbedding("extension");
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    ...embeddingFailureDiagnostic(error, performance.now() - startedAt, GEMINI_EMBEDDING_MODEL),
  }, null, 2));
  process.exitCode = 1;
} finally {
  await closeDb();
}
