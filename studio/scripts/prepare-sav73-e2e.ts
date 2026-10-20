import { createCipheriv, createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { SAV53_E2E_KEY, SAV53_THREADS, sav53Proposal } from "../test/sav53-e2e-fixture";
const target = path.resolve(process.env.STUDIO_E2E_DB_DIR ?? ".e2e-sav73-db");
if (process.env.NODE_ENV === "production" || process.env.DATABASE_URL !== `pglite://${target}` || process.env.SAV_ENCRYPTION_KEY_V1 !== SAV53_E2E_KEY || process.env.SAV_WRITES_DISABLED !== "true") throw new Error("LOCAL_SYNTHETIC_E2E_CONFIGURATION_REQUIRED");
const client = new PGlite(`file://${target}`, { extensions: { vector } });
function encrypt(value: unknown) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(SAV53_E2E_KEY).digest(), iv);
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);
  return ["v1",iv.toString("base64url"),cipher.getAuthTag().toString("base64url"),ciphertext.toString("base64url")].join(".");
}
const body=encrypt({text:"Demande synthétique de recette navigation."});
try {
  await client.exec(`INSERT INTO sav.threads(id,mailbox_id,gmail_thread_id,subject,customer_email)
    SELECT ('00000073-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid, (SELECT id FROM sav.mailboxes WHERE email='contact@limova.ai'), 'synthetic-sav73-'||i,'Pagination synthétique '||i,'navigation-'||i||'@example.invalid' FROM generate_series(1,30) i`);
  await client.query(`INSERT INTO sav.messages(thread_id,mailbox_id,gmail_message_id,direction,from_email,subject,body_ciphertext,received_at)
    SELECT id,mailbox_id,gmail_thread_id,'inbound',customer_email,subject,$1,'2026-10-04'::timestamptz FROM sav.threads WHERE gmail_thread_id LIKE 'synthetic-sav73-%'`,[body]);
  // Unlike the original SAV53 fixture (no AI draft), the feedback scenario must
  // contain an actual initial suggestion distinct from the saved human version.
  await client.query(`UPDATE sav.agent_runs SET proposal_ciphertext=$1 WHERE message_id IN
    (SELECT id FROM sav.messages WHERE thread_id=$2)`,
    [encrypt({...sav53Proposal(false),replyDraft:"Bonjour, voici une suggestion IA synthétique à relire avant toute utilisation."}),SAV53_THREADS.singlePlain]);
  console.log("SAV-73: thirty additional synthetic pagination dossiers prepared.");
} finally { await client.close(); }
