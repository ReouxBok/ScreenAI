import { afterEach, describe, expect, it, vi } from "vitest";
import type { SavRetrievalCandidate } from "../../request-retrieval";
import { SAV_CASE_REASK_ADVISOR_NOTICE } from "../ask-before-handoff";
import { emptyCaseBody, SAV_CASE_CONTRACT_REVISION, type CaseBody, type CaseEvent, type CaseSnapshot } from "../case-types";
import { buildCaseDecisionContext } from "../decision-context";
import type { CaseDecisionValidation } from "../decision-contract";
import { validateCaseDecision } from "../decision-validator";
import { smartNudgeRespectsDecisionOn } from "../smart-entry-switch";
import { smartHandoffProposal } from "./smart-case-provider";
import type { SmartTeamNote } from "./smart-contract";

/*
 * 26/11 real case, paraphrased with fictional data only: turn 1 the smart brain asks (its internal `memory.question` label is what the case stores as the
 * question's text), the customer answers that the conversation is gone so no link can be sent, turn 2 the brain hands over (`real_bug` →
 * `diagnosis_out_of_tools`). On main, `SAV_V2_ASK_BEFORE_HANDOFF=on` replaces that hand-over by the server's re-ask, quoting the internal label as
 * a question « restée sans réponse ».
 */

const LABEL = "Précisions sur l'emplacement de recherche, URL de la conversation et captures d'écran.";
const FIRST = "Bonjour, je ne retrouve plus un contrat généré hier dans mon historique. Client Test, client.test@exemple.invalid";
const ANSWER = "Bonsoir, la discussion a disparu, je ne peux donc pas vous envoyer l'URL. Client Test, client.test@exemple.invalid";
const card = { id: "fiche-espaces", contentVersionId: "v1", title: "Espaces de travail", source: "fixture", verifiedAt: "2026-11-20T00:00:00Z", semanticScore: null,
  content: "Créer, renommer et supprimer un espace de travail.", resolution: { steps: [], exceptions: [] },
  availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" } } as unknown as SavRetrievalCandidate;
const ev = (seq: number, kind: CaseEvent["kind"], direction: CaseEvent["direction"], id: string, at: string): CaseEvent =>
  ({ id: `e${seq}`, caseId: "case-1", kind, dedupeKey: `${kind}:${seq}`, caseVersion: seq, direction, occurredAt: at, sourceRef: { type: "email", id }, detail: null, createdAt: at });
const events = [ev(1, "inbound_confirmed", "customer_inbound", "m1", "2026-11-26T18:50:00Z"), ev(2, "outbound_observed", "agent_outbound", "a1", "2026-11-26T18:53:20Z"),
  ev(3, "inbound_confirmed", "customer_inbound", "m2", "2026-11-26T19:16:23Z")];
const body = { ...emptyCaseBody(), openRequests: [{ id: "r1", summary: "Retrouver une conversation disparue.", family: "other", status: "open", openedAt: "2026-11-26T18:50:00Z" }],
  // The smart provider stores the brain's internal label as the question text, with no fact key (`smartProposalFromTurn`, outcome ask).
  questions: [{ id: "in:e1:q1", text: LABEL, factKeys: [], askedAt: "2026-11-26T18:53:20Z", askedInEffect: "eff-1" }] } as unknown as CaseBody;
const snapshot = (admission: CaseSnapshot["admission"]) => ({ contractRevision: SAV_CASE_CONTRACT_REVISION, caseId: "case-1", ticketId: "t-1", threadIds: ["th-1"], version: 3,
  owner: "agent", phase: "queued", sensitivity: "none", createdAt: "2026-11-26T18:50:00Z", updatedAt: "2026-11-26T19:16:30Z", admissionInputVersion: 1, admission, body }) as unknown as CaseSnapshot;
const SMART = { target: "agent", admission: "smart_support", qualification: { requests: [], identity: { status: "unknown" }, crmContext: "complete", teamSignals: [] } } as unknown as CaseSnapshot["admission"];
const TOLD = "Comme vous ne pouvez plus accéder à l'échange pour nous transmettre son lien, je transmets votre dossier à notre équipe technique.";
const note: SmartTeamNote = { raison: "real_bug", besoin: "Retrouver une conversation disparue.", compris: "Le fil de conversation n'apparaît plus dans l'historique du client.",
  verifie: [], essaye: [], hypotheses: [{ texte: "Problème d'affichage de l'historique.", statut: "ouverte" }],
  prochaineVerification: "Vérifier si la conversation est archivée, masquée ou supprimée.", ditAuClient: TOLD };

function decide(admission = SMART) {
  const snap = snapshot(admission);
  const proposal = smartHandoffProposal({ snapshot: snap, knowledge: [card] }, { reason: "diagnosis_out_of_tools", note, noteText: null });
  const built = buildCaseDecisionContext({ snapshot: snap, events, knowledge: [card], locale: "fr-FR", audience: "support", admission: { admitted: true },
    customerTexts: { "email:m1": FIRST, "email:m2": ANSWER } });
  if (!built.ok) throw new Error(built.problem);
  return { context: built.context, validation: validateCaseDecision(proposal, built.context, new Date("2026-11-26T19:22:04Z")) };
}
const accepted = (validation: CaseDecisionValidation) => { if (validation.outcome !== "accepted") throw new Error(JSON.stringify(validation.rejections)); return validation; };

describe("SAV_V2_SMART_NUDGE_RESPECTS_DECISION: the smart brain's hand-over is never replaced by the re-ask", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reads only the exact value \"on\"", () => {
    expect(smartNudgeRespectsDecisionOn({ SAV_V2_SMART_NUDGE_RESPECTS_DECISION: "on" })).toBe(true);
    for (const value of [undefined, "", "ON", "true", "1", "shadow"]) expect(smartNudgeRespectsDecisionOn({ SAV_V2_SMART_NUDGE_RESPECTS_DECISION: value })).toBe(false);
  });

  it("off (main): the 26/11 hand-over becomes the re-ask quoting the internal label as unanswered", () => {
    vi.stubEnv("SAV_V2_ASK_BEFORE_HANDOFF", "on");
    const { context, validation } = decide();
    expect("smartRespectsDecision" in context).toBe(false);
    const result = accepted(validation);
    expect(result.signals).toContain("handoff_reask_composed");
    expect(result.decision.nextAction.kind).toBe("ask");
    expect(result.decision.reply?.text).toContain("restée sans réponse");
    expect(result.decision.reply?.text).toContain(LABEL);
    expect(result.decision.reply?.text).toContain(SAV_CASE_REASK_ADVISOR_NOTICE);
  });

  it("on, smart case: the brain's hand-over is accepted with its note, no re-ask and no customer reply quoting the label", () => {
    vi.stubEnv("SAV_V2_ASK_BEFORE_HANDOFF", "on");
    vi.stubEnv("SAV_V2_SMART_NUDGE_RESPECTS_DECISION", "on");
    const { context, validation } = decide();
    expect(context.smartRespectsDecision).toBe(true);
    const result = accepted(validation);
    expect(result.signals).not.toContain("handoff_reask_composed");
    expect(result.decision.nextAction).toMatchObject({ kind: "handoff", reason: "diagnosis_out_of_tools", requestIds: ["r1"],
      report: { need: note.besoin, observed: note.compris, expectedIntervention: note.prochaineVerification } });
    expect(result.decision.reply ?? null).toBeNull();
    expect(JSON.stringify(result.decision)).not.toContain("restée sans réponse");
  });

  it("on, case not admitted by the smart entry: the context keeps main's shape and the re-ask is unchanged", () => {
    vi.stubEnv("SAV_V2_ASK_BEFORE_HANDOFF", "on");
    vi.stubEnv("SAV_V2_SMART_NUDGE_RESPECTS_DECISION", "on");
    const { context, validation } = decide(null);
    expect("smartRespectsDecision" in context).toBe(false);
    expect(accepted(validation).signals).toContain("handoff_reask_composed");
  });

  it("on, re-ask switch off: the hand-over is accepted exactly as on main", () => {
    vi.stubEnv("SAV_V2_SMART_NUDGE_RESPECTS_DECISION", "on");
    const on = accepted(decide().validation);
    vi.unstubAllEnvs();
    const off = accepted(decide().validation);
    expect(on.decision).toEqual(off.decision);
    expect(on.decision.nextAction.kind).toBe("handoff");
  });
});
