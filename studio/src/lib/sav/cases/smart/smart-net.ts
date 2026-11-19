import { containsPromptInjection } from "../../policy";
import { accessSkillKernelHits } from "../access-skill/access-skill-kernel";
import { maskCaseCustomerText } from "../investigation-customer-context";
import { caseSensitiveFamiliesInText } from "../sensitive-words";

/*
 * Agent SAV intelligent, lot D1, step 0 (20/11): the safety net WITHOUT any model. Pure: no model, network, database or clock.
 *
 * Astra's correction (`message-context.ts:47-57`): the existing readers keep the current body and set the signature aside, then bound the
 * latest message; a PS classified as signature could disappear before any truncation signal. This net therefore reads the INTEGRAL raw text
 * (subject, body, signature, PS and quoted history) BEFORE any split or bound. Anything it finds sends the WHOLE mail to the team, 0 paid call:
 *   - a kernel phrase of the Access skill (cancel, refund, close the account, GDPR, bank dispute...);
 *   - a sensitive family of the fixed V2 word rule (cancellation, finance, subscription, rights, identity), the login infinitive set aside;
 *   - text that looks like an instruction aimed at the model;
 *   - a mail too long to be given whole to the model (never a partial reading), or an empty one.
 * The model's reading (step 1) is the second barrier; the server's checks on the agent's own reply (`smart-checks.ts`) the third.
 */

/** A mail longer than this (masked, characters) is never given to the model in part: the whole mail goes to the team. */
export const SAV_SMART_MAIL_MAX_CHARS = 8_000;
export const SAV_SMART_SUBJECT_MAX_CHARS = 300;

export type SmartNetResult = Readonly<{ stop: false }> | Readonly<{ stop: true; reasons: readonly string[] }>;

/** Step 0 on the integral raw texts (never split, never bounded). `reasons`: closed codes only. */
export function smartSafetyNet(input: Readonly<{ subject: string; body: string }>): SmartNetResult {
  const subject = String(input.subject ?? ""), body = String(input.body ?? "");
  const whole = `${subject}\n${body}`;
  const reasons = [
    ...accessSkillKernelHits(whole).map(id => `kernel:${id}`),
    ...caseSensitiveFamiliesInText(whole).map(family => `sensitive:${family}`),
  ];
  if (containsPromptInjection(whole)) reasons.push("instruction_in_mail");
  if (!body.trim() && !subject.trim()) reasons.push("empty");
  if (smartMask(body).length > SAV_SMART_MAIL_MAX_CHARS || smartMask(subject).length > SAV_SMART_SUBJECT_MAX_CHARS) reasons.push("too_long");
  return reasons.length ? { stop: true, reasons: [...new Set(reasons)] } : { stop: false };
}

/**
 * What the model may read of a customer text: secrets named as such, tokens, keys, IBANs, cards, phones AND email addresses masked
 * (`maskCaseCustomerText`, emails on). Masking runs before any bound, so a cut never exposes half of a secret. Idempotent.
 */
export const smartMask = (value: string) => maskCaseCustomerText(String(value ?? ""), { emails: true });
