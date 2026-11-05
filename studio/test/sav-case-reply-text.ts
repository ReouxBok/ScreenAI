import { CASE_REPLY_V2_MODE, prepareCaseReplyText } from "@/lib/sav/cases/case-reply-outbound";

/**
 * A fixture's reply text, FINAL as the contract sav-v2-reply-outbound.v1 requires before a proposal is stored (the store never appends the AI mention). The language is explicit:
 * a test says "fr" or "en", nothing is inferred from the text, the model or the customer. Idempotent, like the production preparation.
 */
export const finalReplyText = (text: string, language: "fr" | "en" = "fr") => prepareCaseReplyText(text, language, CASE_REPLY_V2_MODE);
