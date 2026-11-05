// SAV-10 (pole C): `sav.case_reply_validations` now lives in db/schema.ts, created by pole A's migration 0051.
import "server-only";
import { savCaseReplyValidations } from "@/db/schema";

export { savCaseReplyValidations };
export type CaseReplyValidationRow = typeof savCaseReplyValidations.$inferSelect;
