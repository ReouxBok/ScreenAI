// V1 → V2 case thread reply (25/11, behind `SAV_V2_CASE_THREAD_REPLY=on`). The PURE part: the switch, its revision, the one prompt sentence it adds.
// With the switch on, the understanding call may report a message's nature as `acknowledgement` (a thank-you or a confirmation, nothing new asked), and a
// reply on a thread that one V2 case owns, whose scope the model left uncertain, is relayed to that case (`v2_case_thread`) instead of « À valider ».
// Off (absent or anything but the exact `on`): the prompt, the wire schema, the decisions and the launch fingerprint are those of before.

export const SAV_V2_CASE_THREAD_REPLY_REVISION = "sav-v2-case-thread-reply-2026-11-25.v1";

export const savV2CaseThreadReplyEnabled = (env: Readonly<Record<string, string | undefined>>) => env.SAV_V2_CASE_THREAD_REPLY === "on";

/** The natures the understanding call may report. `acknowledgement` is offered to the model only with the switch on. */
export const SAV_INTAKE_BASE_NATURES = ["request", "newsletter", "information", "indeterminate"] as const;
export const SAV_INTAKE_NATURES = [...SAV_INTAKE_BASE_NATURES, "acknowledgement"] as const;

/** The one sentence added to the understanding prompt with the switch on. */
export const SAV_CASE_THREAD_NATURE_GUIDELINE = "Report nature acknowledgement (with acknowledgement requests) only when the CURRENT authored message just thanks, confirms that a solution works or that the matter is settled, and asks nothing new; any question, persisting problem or new ask keeps nature request.";

/** Console reason of a reply relayed to its V2 case. */
export const SAV_CASE_THREAD_CONSOLE_REASON = "Réponse sur un fil suivi par un dossier V2 : transmise au dossier V2, aucune validation demandée.";
