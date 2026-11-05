// Lot C (4/11, LOCAL, SYN): what a page may say about the V1 -> V2 owner passage of one case. Pure, like `case-owner-situation.ts`, whose verdict it reuses:
// it reads, writes and calls nothing. The closed list below never promises what HubSpot cannot prove: there is no conditional owner write, so an owner comparison is a
// read followed by a local commit, never an atomic step. `atomicOwnerCompare` is therefore the constant "not_proven", and only a fresh "v2" reading allows new work.
import { describeCaseOwnerSituation, type CaseOwnerReadingInput, type CaseOwnerSituation } from "./case-owner-situation";
import type { CaseSnapshot } from "./case-types";

export const SAV_PILOT_PASSAGE_STATES = [
  "agent_ready", "person_took_after_verification", "team_person", "team_out_of_scope", "team_waiting_owner", "agent_pending_owner_read", "held_owner_unread", "held_system",
] as const;
export type PilotPassageState = typeof SAV_PILOT_PASSAGE_STATES[number];
export type PilotPassageView = Readonly<{
  state: PilotPassageState;
  situation: CaseOwnerSituation;
  /** Only `agent_ready`, and C still reads the owner again before every new step. */
  v2Work: boolean;
  /** Never true: no path of the passage writes a ticket owner. */
  ownerWrite: false;
  /** HubSpot offers no compare-and-set on the owner: nothing here may be shown as guaranteed. */
  atomicOwnerCompare: "not_proven";
  caseOwner: CaseSnapshot["owner"];
  crmReading: CaseOwnerReadingInput;
  admission: Readonly<{ target: string; reasons: readonly string[] }> | null;
}>;

const FROM_SITUATION: Readonly<Record<Exclude<CaseOwnerSituation, "agent_unconfirmed">, PilotPassageState>> = {
  agent: "agent_ready", human_owner: "team_person", excluded_sensitive: "team_out_of_scope", team_not_admitted: "team_out_of_scope", admitted_take_blocked: "team_waiting_owner",
  v2_owner_read_pending: "agent_pending_owner_read", owner_unknown: "held_owner_unread", system_hold: "held_system",
};

/** A case still locally the agent's while the CRM reads a person, or nobody, was taken after V1's verification: no new work, whatever the local row says. Anything unread holds. */
function unconfirmedState(reading: CaseOwnerReadingInput): PilotPassageState {
  return reading === "human" || reading === "none" ? "person_took_after_verification" : "held_owner_unread";
}

export function readPilotPassage(current: Pick<CaseSnapshot, "owner" | "phase" | "body" | "sensitivity" | "admission">, reading: CaseOwnerReadingInput): PilotPassageView {
  const { situation, v2Work } = describeCaseOwnerSituation(current, reading);
  return {
    state: situation === "agent_unconfirmed" ? unconfirmedState(reading) : FROM_SITUATION[situation], situation, v2Work, ownerWrite: false, atomicOwnerCompare: "not_proven",
    caseOwner: current.owner, crmReading: reading, admission: current.admission ? { target: current.admission.target, reasons: current.admission.reasons } : null,
  };
}
