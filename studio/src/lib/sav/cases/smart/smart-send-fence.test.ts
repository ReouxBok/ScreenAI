import { describe, expect, it } from "vitest";
import { smartSendProblem, smartSwitchProblem } from "./smart-send-fence";

// PORTE 2A: the smart send fence and the switches read again before a queued smart reply leaves (pure).
const SMART = { qualification: { requests: [{ provenance: { kind: "qualified_rule", ruleId: "smart-entry", revision: "smart-entry.v1", blockId: "smart-support" } }] } };
const ACCESS = { qualification: { requests: [{ provenance: { kind: "qualified_rule", ruleId: "rule-access", revision: "r1", blockId: "access" } }] } };
const judge = (body: string) => smartSendProblem({ admission: SMART, body, purpose: "answer" });

describe("PORTE 2A (P2) : le filet smart refuse seulement ce que prévoit le CAP", () => {
  it.each([
    "Pour la question de remboursement, notre équipe vous répondra.",
    "Votre question sur la facturation est transmise à notre équipe.",
    "Arrêtez la routine depuis votre compte Limova.",
  ])("mention neutre : « %s » passe", body => expect(judge(body)).toBeNull());
  it.each([
    "Pour résilier, écrivez-nous.",
    "Ouvrez la rubrique Abonnement puis cliquez sur Annuler.",
    "Nous allons vous rembourser dès aujourd'hui.",
    "Votre compte a été supprimé.",
  ])("résiliation ou engagement sensible : « %s » refusé", body => expect(judge(body)).toBe("CANCELLED_REPLY_SENSITIVE_WORDING"));
  it("un dossier non smart et une notice de passage ne sont jamais jugés ici", () => {
    expect(smartSendProblem({ admission: ACCESS, body: "Pour résilier, écrivez-nous.", purpose: "answer" })).toBeNull();
    expect(smartSendProblem({ admission: SMART, body: "Pour résilier, écrivez-nous.", purpose: "handoff" })).toBeNull();
  });
});

describe("PORTE 2A (P1) : interrupteurs smart relus avant l'envoi", () => {
  const RULE = "30000000-0000-4000-8000-000000000009";
  const ON = { SAV_V2_ENTRY_SMART: "on", SAV_V2_SMART_SUPPORT_MODE: "auto", SAV_V2_AUTO_REPLY: "access", SAV_V2_AUTO_APPROVER_ID: RULE };
  const auto = (env: Record<string, string | undefined>) => smartSwitchProblem({ env, admission: SMART, basis: "auto_access.v1", approvedBy: RULE });
  const person = (env: Record<string, string | undefined>) => smartSwitchProblem({ env, admission: SMART, basis: "fixture.human", approvedBy: "someone" });
  it("tout allumé : rien à redire", () => expect(auto(ON)).toBeNull());
  it.each([
    [{ SAV_V2_ENTRY_SMART: "off" }, "CANCELLED_SMART_ENTRY_OFF"],
    [{ SAV_V2_SMART_SUPPORT_MODE: undefined }, "CANCELLED_SMART_AUTO_OFF"],
    [{ SAV_V2_SMART_SUPPORT_MODE: "AUTO" }, "CANCELLED_SMART_AUTO_OFF"],
    [{ SAV_V2_AUTO_REPLY: "off" }, "CANCELLED_SMART_AUTO_OFF"],
    [{ SAV_V2_AUTO_APPROVER_ID: "30000000-0000-4000-8000-000000000001" }, "CANCELLED_SMART_AUTO_OFF"],
  ])("approbation par la règle, %o : refus", (change, code) => expect(auto({ ...ON, ...change })).toBe(code));
  it("approbation humaine : SAV_V2_ENTRY_SMART seul est exigé", () => {
    expect(person({ SAV_V2_ENTRY_SMART: "on" })).toBeNull();
    expect(person({})).toBe("CANCELLED_SMART_ENTRY_OFF");
  });
  it("un dossier non smart n'est pas concerné", () =>
    expect(smartSwitchProblem({ env: {}, admission: ACCESS, basis: "auto_access.v1", approvedBy: RULE })).toBeNull());
});
