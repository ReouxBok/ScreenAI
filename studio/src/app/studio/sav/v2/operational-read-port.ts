import { readCaseReplyOperationalState } from "@/lib/sav/cases/case-operational-read";
import type { OperationalReader } from "./operational-state-view";

// UX lot 10 raccord, COMPOSITION ONLY: pole C9's read-only operational reader bound to the V2 case page's selected-reply detail. The page calls it only after its
// staff check, with an access callback built from that check's result (operational-state-view.ts); null would read "non branché".
export const operationalReader: OperationalReader | null = (input, deps) => readCaseReplyOperationalState(input, deps);
