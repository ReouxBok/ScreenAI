import { describe, expect, it } from "vitest";
import { accessSkillKernelHits } from "../../access-skill/access-skill-kernel";
import { renderSkillPrompt, skillFingerprint } from "../../../skills/skill-contract";
import {
  integrationsDecisionSchema, SAV_INTEGRATIONS_DECISION_EXAMPLES, SAV_INTEGRATIONS_DECISION_SKILL, SAV_INTEGRATIONS_DECISION_SKILL_PROMPT_SHA256,
  SAV_INTEGRATIONS_DECISION_SKILL_REVISION, SAV_INTEGRATIONS_HANDOFF_REASONS, SAV_INTEGRATIONS_QUESTION_KINDS,
} from "./integrations-decision-skill";
import {
  integrationsEntryJudgmentSchema, SAV_INTEGRATIONS_ENTRY_EXAMPLES, SAV_INTEGRATIONS_ENTRY_SKILL, SAV_INTEGRATIONS_ENTRY_SKILL_PROMPT_SHA256,
  SAV_INTEGRATIONS_ENTRY_SKILL_REVISION, SAV_INTEGRATIONS_ROUTER_LINE,
} from "./integrations-entry-skill";

// Block « Intégrations » (V3, 19/11): both skills, their fictional examples, strict schemas and the hash bound to each revision.
describe("révision liée à l'empreinte du prompt rendu", () => {
  it("entrée : l'empreinte épinglée est celle du prompt rendu (consignes, exemples, schéma)", () => {
    // Edit the skill => this fails. Bump the revision AND the pinned hash together; the new revision admits nobody until approved.
    expect(skillFingerprint(SAV_INTEGRATIONS_ENTRY_SKILL)).toBe(SAV_INTEGRATIONS_ENTRY_SKILL_PROMPT_SHA256);
    expect(SAV_INTEGRATIONS_ENTRY_SKILL_REVISION).toBe("sav-integrations-entry-skill-2026-11-19.v1");
    expect(SAV_INTEGRATIONS_ENTRY_SKILL.role).toBe("confirm");
  });
  it("décision : l'empreinte épinglée est celle du prompt rendu", () => {
    expect(skillFingerprint(SAV_INTEGRATIONS_DECISION_SKILL)).toBe(SAV_INTEGRATIONS_DECISION_SKILL_PROMPT_SHA256);
    expect(SAV_INTEGRATIONS_DECISION_SKILL_REVISION).toBe("sav-integrations-decision-skill-2026-11-19.v1");
    expect(SAV_INTEGRATIONS_DECISION_SKILL.role).toBe("decision");
  });
  it("le prompt rendu contient la révision, chaque exemple et le schéma", () => {
    for (const skill of [SAV_INTEGRATIONS_ENTRY_SKILL, SAV_INTEGRATIONS_DECISION_SKILL]) {
      const prompt = renderSkillPrompt(skill);
      expect(prompt).toContain(skill.revision);
      for (const example of skill.examples) expect(prompt).toContain(JSON.stringify(example.id));
      expect(prompt).toContain("Output JSON schema");
    }
  });
});

describe("skill d'entrée : consignes et exemples (contrat commun d'entrée)", () => {
  const examples = SAV_INTEGRATIONS_ENTRY_EXAMPLES;
  it("20 exemples courts (le plafond d'octets l'emporte sur les 40 de la méthode), ids uniques, les 4 verdicts et chaque famille sensible", () => {
    expect(examples).toHaveLength(20);
    expect(new Set(examples.map(row => row.id)).size).toBe(examples.length);
    for (const verdict of ["block", "team_sensitive", "team_other", "team_unsure"]) expect(examples.some(row => row.verdict === verdict), verdict).toBe(true);
    for (const family of ["cancellation", "subscription", "finance", "rights", "identity"]) expect(examples.some(row => row.family === family), family).toBe(true);
  });
  it("chaque voisin du brief a un exemple : Accès, Charly Max, routine, commercial", () => {
    for (const neighbour of ["access", "charly_max", "platform_bug", "commercial"]) expect(examples.some(row => row.neighbour === neighbour), neighbour).toBe(true);
  });
  it("au moins 9 paires proches, réciproques, avec un verdict opposé (bloc ↔ équipe)", () => {
    const pairs = examples.filter(row => row.pair);
    expect(pairs.length).toBeGreaterThanOrEqual(18);
    for (const row of pairs) {
      const twin = examples.find(candidate => candidate.id === row.pair);
      expect(twin, row.id).toBeDefined();
      expect(twin!.pair, row.id).toBe(row.id);
      expect((row.verdict === "block") !== (twin!.verdict === "block"), row.id).toBe(true);
    }
  });
  it("famille si et seulement si sensible ; voisin seulement pour « other » ; aucun exemple admis avec une phrase du noyau", () => {
    for (const row of examples) {
      expect(Boolean(row.family), row.id).toBe(row.verdict === "team_sensitive");
      if (row.neighbour) expect(row.verdict, row.id).toBe("team_other");
      if (row.verdict === "block") expect(accessSkillKernelHits("", row.text), row.id).toEqual([]);
    }
  });
  it("les règles propres au bloc sont dans la consigne (le cadre commun porte le reste) ; ligne du routeur ≤ 240 caractères", () => {
    const prompt = renderSkillPrompt(SAV_INTEGRATIONS_ENTRY_SKILL);
    for (const rule of ["la facturation de l'outil tiers lui-même", "QUESTION DÉCISIVE", "Un bug supposé de liaison reste le bloc"]) expect(prompt).toContain(rule);
    expect(SAV_INTEGRATIONS_ROUTER_LINE.covers.length).toBeLessThanOrEqual(240);
    expect(SAV_INTEGRATIONS_ROUTER_LINE.notThis.length).toBeLessThanOrEqual(240);
  });
});

describe("skill de décision : consignes et exemples", () => {
  const examples = SAV_INTEGRATIONS_DECISION_EXAMPLES;
  it("40 à 60 exemples, chaque action représentée, détails fermés", () => {
    expect(examples.length).toBeGreaterThanOrEqual(40);
    expect(examples.length).toBeLessThanOrEqual(60);
    expect(new Set(examples.map(row => row.id)).size).toBe(examples.length);
    for (const verdict of ["answer", "ask", "orient", "handoff"]) expect(examples.some(row => row.verdict === verdict), verdict).toBe(true);
    for (const row of examples) {
      if (row.verdict === "ask") expect(SAV_INTEGRATIONS_QUESTION_KINDS, row.id).toContain(row.detail);
      else if (row.verdict === "handoff") expect(SAV_INTEGRATIONS_HANDOFF_REASONS, row.id).toContain(row.detail);
      else expect(row.detail, row.id).toBeUndefined();
    }
    for (const reason of ["platform_bug", "unexplained_error", "persistent_after_steps", "no_card_for_tool", "card_orient_only", "permissions_or_identity", "sensitive_detected", "secret_received"])
      expect(examples.some(row => row.detail === reason), reason).toBe(true);
  });
  it("jamais de procédure inventée : Shopify, Odoo et les CRM sans fiche answer ne sont jamais « answer »", () => {
    for (const row of examples.filter(row => /Shopify|Odoo|Brevo|Axonaut|Pennylane|Dougs|OVH|HubSpot/.test(row.text) && !/Gmail/.test(row.text))) expect(row.verdict, row.id).not.toBe("answer");
    const prompt = renderSkillPrompt(SAV_INTEGRATIONS_DECISION_SKILL);
    for (const rule of ["JAMAIS DE TOI", "UNE question par mail", "Une question déjà posée ne se repose jamais", "Ne demande jamais mot de passe", "ne dis jamais l'avoir vue"]) expect(prompt).toContain(rule);
  });
});

describe("schémas stricts", () => {
  const entry = { mail: { sensitive: "none", thirdParty: false, instructionLike: false },
    requests: [{ requestId: "r1", verdict: "block", family: null, confidence: "high", quote: "relier Gmail", reason: "tool connection" }],
    sensitiveMentions: [] };
  it("entrée : accepte une lecture complète, refuse tout écart", () => {
    expect(integrationsEntryJudgmentSchema.safeParse(entry).success).toBe(true);
    for (const bad of [{ ...entry, extra: 1 }, { ...entry, requests: [] }, { ...entry, requests: [{ ...entry.requests[0], verdict: "access" }] },
      { ...entry, requests: [{ ...entry.requests[0], subfamily: "gmail_google" }] }, { ...entry, requests: [{ ...entry.requests[0], quote: " " }] }, null, "integrations"])
      expect(integrationsEntryJudgmentSchema.safeParse(bad).success).toBe(false);
  });
  const decision = { requests: [{ requestId: "r1", action: "ask", subfamily: "gmail_google", cardIds: [], question: { kind: "error_text", text: "Quel est le message exact ?" },
    handoffReason: null, facts: { operation: null, errorText: null, stepsTried: null, screenshot: "absent_never_asked" }, reason: "branch unknown" }], reply: "Bonjour", teamPart: false };
  it("décision : accepte une décision complète, refuse tout écart", () => {
    expect(integrationsDecisionSchema.safeParse(decision).success).toBe(true);
    for (const bad of [{ ...decision, extra: true }, { ...decision, requests: [{ ...decision.requests[0], action: "refund" }] },
      { ...decision, requests: [{ ...decision.requests[0], handoffReason: "because" }] }, { ...decision, requests: [{ ...decision.requests[0], cardIds: ["a", "b", "c", "d"] }] },
      { ...decision, requests: [{ ...decision.requests[0], question: { kind: "password", text: "x" } }] }])
      expect(integrationsDecisionSchema.safeParse(bad).success).toBe(false);
  });
});
