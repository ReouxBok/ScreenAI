import { readCaseQualificationDiagnostic } from "@/lib/sav/cases/case-store";

// UX lot 7 raccord, COMPOSITION ONLY: pole A6's read-only qualification diagnostic bound to the V2 case page. The page calls it only after its staff check,
// with the caller built from that check's result (qualification-diagnostic-view.ts); null would read "non branché".
export const qualificationDiagnosticReader: typeof readCaseQualificationDiagnostic | null = readCaseQualificationDiagnostic;
