import "dotenv/config";
import { closeDb } from "../src/db/client";
import { reconcileStaleTrainings } from "../src/lib/training";

const apply = process.argv.includes("--apply");
const dryRun = process.argv.includes("--dry-run") || !apply;

try {
  const result = await reconcileStaleTrainings({
    dryRun,
    actorEmail: "admin-script@limova.ai",
  });
  console.log(JSON.stringify({ mode: dryRun ? "dry-run" : "apply", ...result }, null, 2));
} finally {
  await closeDb();
}
