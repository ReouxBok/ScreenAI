import { createCipheriv, createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { savMailboxes, savMessages, savSyncState, savThreads } from "../src/db/schema";
import { SAV_OTHER_CASES, SAV_OTHER_E2E_KEY, SAV_OTHER_MAILBOX, SAV_OTHER_THREAD } from "../test/sav-other-e2e-fixture";

const target = path.resolve(".e2e-db-sav-other");
if (process.env.NODE_ENV === "production" || process.env.DATABASE_URL !== `pglite://${target}` || process.env.STUDIO_E2E_DB_DIR !== target || process.env.SAV_ENCRYPTION_KEY_V1 !== SAV_OTHER_E2E_KEY || process.env.SAV_WRITES_DISABLED !== "true") throw new Error("LOCAL_SYNTHETIC_OTHER_CONFIGURATION_REQUIRED");
function encrypt(value: unknown) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(SAV_OTHER_E2E_KEY).digest(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}
const client = new PGlite(`file://${target}`, { extensions: { vector } });
const db = drizzle(client);
try {
  await db.insert(savMailboxes).values({ id: SAV_OTHER_MAILBOX, email: "contact@limova.ai", active: true });
  await db.insert(savSyncState).values({ key: "sav-v0-cutover", status: "active", cursor: JSON.stringify({ receivedAfter: "2026-10-01T00:00:00Z", mailboxEmail: "contact@limova.ai", intakeRecipient: "contact@limova.ai", deploymentSha: "a".repeat(40), activatedBy: "ugo@limova.ai" }) });
  const inputs = [...SAV_OTHER_CASES,
    { sender: SAV_OTHER_CASES[0].sender, subject: "AUTRE88 — avis synthétique 2 étoiles" },
    { sender: "customer@example.invalid", subject: "Re: " + SAV_OTHER_CASES[3].subject },
    { ...SAV_OTHER_CASES[1] }, // Exact promotion, but an already linked customer dossier.
  ];
  for (const [index, input] of inputs.entries()) {
    const threadId = SAV_OTHER_THREAD(index + 1), receivedAt = new Date(Date.parse("2026-10-14T09:00:00Z") + index * 60_000);
    await db.insert(savThreads).values({ id: threadId, mailboxId: SAV_OTHER_MAILBOX, gmailThreadId: `synthetic-other-${index}`, subject: input.subject, customerEmail: input.sender, hubspotTicketId: index === 6 ? "fixture-other-ticket" : null });
    await db.insert(savMessages).values({ mailboxId: SAV_OTHER_MAILBOX, threadId, gmailMessageId: `synthetic-other-${index}`, direction: "inbound", fromEmail: input.sender, toEmails: ["contact@limova.ai"], subject: input.subject,
      bodyCiphertext: encrypt({ text: "Notification entièrement synthétique de recette. Aucun client réel.", headers: { "message-id": `<synthetic-other-${index}@example.invalid>`, "content-type": "text/plain", references: index === 5 ? "<synthetic-parent@example.invalid>" : "", "in-reply-to": index === 5 ? "<synthetic-parent@example.invalid>" : "" } }), receivedAt, analysisStatus: "done" });
  }
  console.log("Autre: seven synthetic local dossiers, four candidates; no provider access.");
} finally { await client.close(); }
