import { createHash } from "node:crypto";
import { SAV53_E2E_KEY } from "./sav53-e2e-fixture";

export const SAV_OTHER_E2E_KEY = SAV53_E2E_KEY;
export const SAV_OTHER_MAILBOX = "00000088-0000-4000-8000-000000000001";
export const SAV_OTHER_CASES = [
  { family: "trustpilot_positive", sender: "noreply.notifications@trustpilot.com", subject: "AUTRE88 — notification synthétique avis 5 étoiles" },
  { family: "vistaprint_promotions", sender: "vistaprint@mail.vistaprint.fr", subject: "AUTRE88 — promotion synthétique imprimerie" },
  { family: "datarevolution_prospecting", sender: "contact@datarevolution.biz", subject: "AUTRE88 — prospection synthétique Beta" },
  { family: "own_campaign_copy", sender: "hello@limova.ai", subject: "AUTRE88 — copie campagne synthétique Gamma" },
] as const;
export const SAV_OTHER_E2E_REGISTRY = JSON.stringify({ version: 1, rules: SAV_OTHER_CASES.map(item => ({ family: item.family, mailboxId: SAV_OTHER_MAILBOX, subjectSha256: [createHash("sha256").update(item.subject).digest("hex")] })) });
export const SAV_OTHER_THREAD = (n: number) => `00000088-0000-4000-8000-${String(n).padStart(12, "0")}`;
