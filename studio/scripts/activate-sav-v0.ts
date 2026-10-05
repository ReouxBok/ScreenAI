import "dotenv/config";
import { closeDb } from "../src/db/client";
import { activateSavV0Cutover } from "../src/lib/sav/cutover";

// Run only after Ugo approves a specific deployed commit and its ready timestamp.
function argument(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? "";
}
if (!process.argv.includes("--confirm-ugo-approved-cutover")) throw new Error("SAV_CUTOVER_CONFIRMATION_REQUIRED");
try {
  const result = await activateSavV0Cutover({
    receivedAfter: argument("deployed-at"), mailboxEmail: argument("mailbox-email").toLowerCase(),
    intakeRecipient: "contact@limova.ai", deploymentSha: argument("deployment-sha"), activatedBy: "ugo@limova.ai",
  });
  console.log(JSON.stringify({ cutover: result, immutable: true }));
} finally { await closeDb(); }
