import { getCaseReplyEffect, listCaseReplyEffects } from "@/lib/sav/cases/case-reply-registry";
import type { CaseReplyReaders } from "./case-replies";

// SAV-10 raccord, COMPOSITION ONLY: pole C's read-only registry bound to the V2 case page. Its table is still a DDL proposal to pole A.
export const caseReplyReaders: CaseReplyReaders | null = { get: getCaseReplyEffect, list: listCaseReplyEffects };
