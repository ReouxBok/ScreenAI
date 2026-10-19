/** Only the new suggestion confirmation canonicalizes browser form line endings.
 * Legacy queued v3 replies retain their exact historical bytes and hash. */
export const SAV_REPLY_CONFIRMATION_TEXT_REVISION = "sav-confirmation-lf.v1";
export function normalizeSavConfirmationText(text: string) {
  return text.replace(/\r\n?/g, "\n");
}
