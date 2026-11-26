import type { CaseCustomerContext } from "../investigation-customer-context";
import {
  caseAttachmentPartsOf, fitCaseCustomerAttachmentMedia,
  type CaseCustomerAttachmentMedia, type CaseCustomerAttachments, type CaseCustomerEvidence,
} from "../investigation-customer-attachments";
import { SAV_SMART_ENTRY_ADMISSION, savV2EntrySmartOn } from "../smart-entry-switch";
import type { CaseSnapshot } from "../case-types";

/*
 * Agent SAV smart, images jointes (26/11): a customer often sends only a screenshot (« Pouvez-vous résoudre cela ? » + a capture). Behind
 * `SAV_V2_SMART_ATTACHMENT_IMAGES=on` (exactly; absent or any other value: off), the smart brain sees the admitted images of the customer's latest
 * mail (and the previous one) on its `understand` and `decide` calls. Nothing is rewritten: the files are read by V2's existing attachments reader
 * (`investigation-customer-attachments-reader.ts`: Gmail GET only, references re-validated, admission and size/count limits of V1), and fitted,
 * appended and instructed by the existing pure helpers (`investigation-customer-attachments.ts`).
 *
 * Flow, flag read ONCE (by the customer-context reader, which already reads the stored mails of the case):
 *   reader     smart case + flag on: reads the files (images; PDFs too only if `SAV_V2_ATTACHMENT_MEDIA=images_pdf`) and GRANTS the returned context
 *              (`grantSmartCaseAttachments`, in memory, bound to that very object like the media). Off, or not a smart case: no grant, no read.
 *   provider   no grant: the exact previous turn. Grant: fits the media to the turn's image room (`smartCaseAttachments`), records what was refused.
 *   agent      admitted parts present: `understand` and every `decide` pass get the parts, the files view and the attachments instruction.
 *
 * Budget: one V2 reservation covers a smart turn, computed from the policy's `maxInputTokens`. The image allowances of the WHOLE turn (each image
 * counted once per call that carries it, `SAV_SMART_ATTACHMENT_CALLS` calls at most) must fit in the room the policy leaves above the text bound
 * (`maxInputTokens - maxInputBytes`, ≥ 16 384 by the policy check), as V2's decision call does for its single call. A file that does not fit is
 * `input_budget`, never sent.
 */

type Env = Readonly<Record<string, string | undefined>>;
export const SAV_V2_SMART_ATTACHMENT_IMAGES_ENV = "SAV_V2_SMART_ATTACHMENT_IMAGES";
export const smartAttachmentImagesOn = (env: Env) => env[SAV_V2_SMART_ATTACHMENT_IMAGES_ENV] === "on";
/** Whether the reader must read the files of THIS case for the smart brain: flag on, smart entry on and a case admitted by it. */
export const smartCaseWantsAttachments = (env: Env, snapshot: Pick<CaseSnapshot, "admission">) =>
  smartAttachmentImagesOn(env) && savV2EntrySmartOn(env) && snapshot.admission?.admission === SAV_SMART_ENTRY_ADMISSION;

/**
 * Model calls of one turn that may carry the images: `understand` and every `decide` pass (`1 + SAV_SMART_MAX_DECIDE_PASSES`, pinned by the test;
 * not imported, so the customer-context reader does not load the brain). Verify, reverify and correct never carry them.
 */
export const SAV_SMART_ATTACHMENT_CALLS = 4;
/** Reason codes kept in the trace for one turn (per file, then per call that had to drop them). */
export const SAV_SMART_ATTACHMENT_TRACE_CODES = 12;

const grants = new WeakMap<object, Readonly<{ read: boolean }>>();
/** The reader's mark: this context was read for the smart brain (`read: false` when the files could not be read at all). */
export function grantSmartCaseAttachments(context: CaseCustomerContext, read: boolean): CaseCustomerContext {
  grants.set(context, { read });
  return context;
}

/** What one turn sends: the admitted parts in part order, and the view the payload carries (`customerContext.attachments` / `.evidence`). */
export type SmartTurnAttachments = Readonly<{
  media: readonly CaseCustomerAttachmentMedia[];
  context: Readonly<{ attachments: CaseCustomerAttachments; evidence: CaseCustomerEvidence | null }>;
}>;
/** Trace of the attachments of one turn: counts and closed codes only, never a name, a byte or a text. */
export type SmartAttachmentTrace = Readonly<{ admitted: number; refused: readonly string[]; sentWith: readonly string[] }>;

/**
 * The attachments of one turn, or null when the context carries no grant (flag off, not a smart case): the turn is then exactly the previous one.
 * With a grant: the files fitted to the turn's image room (`fit()`, read only now), the parts the fitted view names, and the reason of every file
 * not attached. No part admitted: `turn` is null (text only) and the trace says why.
 */
export function smartCaseAttachments(context: CaseCustomerContext | undefined, fit: () => Readonly<{ model: string; mediaTokens: number }>):
  Readonly<{ turn: SmartTurnAttachments | null; trace: Omit<SmartAttachmentTrace, "sentWith"> }> | null {
  const grant = context ? grants.get(context) : undefined;
  if (!context || !grant) return null;
  if (!grant.read) return { turn: null, trace: { admitted: 0, refused: ["attachments_unavailable"] } };
  if (!context.attachments) return { turn: null, trace: { admitted: 0, refused: [] } };
  const fitted = fitCaseCustomerAttachmentMedia(context, fit());
  const media = caseAttachmentPartsOf(fitted.context, fitted.media);
  const view = fitted.context.attachments!;
  const refused = [...view.files.flatMap(file => file.part === null ? [file.notAttached ?? "unreadable"] : []), ...view.missing].slice(0, SAV_SMART_ATTACHMENT_TRACE_CODES);
  if (!media.length) return { turn: null, trace: { admitted: 0, refused } };
  return { turn: { media, context: { attachments: view, evidence: fitted.context.evidence ?? null } }, trace: { admitted: media.length, refused } };
}
