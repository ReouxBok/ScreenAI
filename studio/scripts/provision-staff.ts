import { randomBytes } from "node:crypto";
import { createClerkClient } from "@clerk/backend";
import { STAFF_DIRECTORY } from "../src/lib/access";

const secretKey = process.env.CLERK_SECRET_KEY;
if (!secretKey) throw new Error("CLERK_SECRET_KEY is required");

const clerk = createClerkClient({ secretKey });
const users = await clerk.users.getUserList({ limit: 100 });
const existingEmails = new Set(users.data.flatMap((user) => user.emailAddresses.map((email) => email.emailAddress.toLowerCase())));

let created = 0;
let skipped = 0;
for (const [emailAddress, staff] of Object.entries(STAFF_DIRECTORY)) {
  if (existingEmails.has(emailAddress)) {
    skipped += 1;
    continue;
  }
  await clerk.users.createUser({
    emailAddress: [emailAddress],
    firstName: staff.name,
    password: randomBytes(32).toString("base64url"),
    locale: "fr-FR",
    skipPasswordChecks: true,
    publicMetadata: { studioRole: staff.role },
  });
  created += 1;
}

console.log(`Comptes Clerk : ${created} créés silencieusement, ${skipped} déjà présents. Aucune invitation envoyée.`);
