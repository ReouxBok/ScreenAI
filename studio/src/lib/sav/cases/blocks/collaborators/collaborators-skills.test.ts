import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { renderSkillPrompt } from "../../../skills/skill-contract";
import { accessSkillKernelHits } from "../../access-skill/access-skill-kernel";
import {
  collaboratorsDecisionSchema, collaboratorsDecisionSkillPrompt, collaboratorsDecisionSkillSha256, SAV_COLLABORATORS_DECISION_EXAMPLES,
  SAV_COLLABORATORS_DECISION_GUIDELINES, SAV_COLLABORATORS_DECISION_SKILL, SAV_COLLABORATORS_DECISION_SKILL_PROMPT_SHA256, SAV_COLLABORATORS_DECISION_SKILL_REVISION,
} from "./collaborators-decision-skill";
import {
  collaboratorsEntryJudgmentSchema, collaboratorsEntrySkillPrompt, collaboratorsEntrySkillSha256, SAV_COLLABORATORS_ENTRY_EXAMPLES, SAV_COLLABORATORS_ENTRY_GUIDELINES,
  SAV_COLLABORATORS_ENTRY_SKILL, SAV_COLLABORATORS_ENTRY_SKILL_PROMPT_SHA256, SAV_COLLABORATORS_ENTRY_SKILL_REVISION, SAV_COLLABORATORS_ENTRY_VERDICTS,
} from "./collaborators-entry-skill";

describe("collaborators skills: revision bound to the rendered prompt", () => {
  it("pins the entry/confirmation prompt (guidelines, examples and schema)", () => {
    // Edit the skill => this fails. Bump the revision AND the pinned hash together; the new revision admits nobody until Ugo approves it.
    expect(collaboratorsEntrySkillSha256()).toBe(SAV_COLLABORATORS_ENTRY_SKILL_PROMPT_SHA256);
    expect(createHash("sha256").update(collaboratorsEntrySkillPrompt(), "utf8").digest("hex")).toBe(SAV_COLLABORATORS_ENTRY_SKILL_PROMPT_SHA256);
    expect(SAV_COLLABORATORS_ENTRY_SKILL_REVISION).toBe("sav-collaborators-entry-skill-2026-11-19.v1");
    expect(SAV_COLLABORATORS_ENTRY_SKILL.role).toBe("confirm");
  });
  it("pins the decision and writing prompt", () => {
    expect(collaboratorsDecisionSkillSha256()).toBe(SAV_COLLABORATORS_DECISION_SKILL_PROMPT_SHA256);
    expect(SAV_COLLABORATORS_DECISION_SKILL_REVISION).toBe("sav-collaborators-decision-skill-2026-11-19.v1");
    expect(SAV_COLLABORATORS_DECISION_SKILL.role).toBe("decision");
  });
  it("renders every example and the strict schemas", () => {
    const entry = collaboratorsEntrySkillPrompt(), decision = collaboratorsDecisionSkillPrompt();
    for (const row of SAV_COLLABORATORS_ENTRY_EXAMPLES) expect(entry).toContain(JSON.stringify(row.text));
    for (const row of SAV_COLLABORATORS_DECISION_EXAMPLES) expect(decision).toContain(JSON.stringify(row.text));
    expect(entry).toContain('"sensitiveMentions"');
    expect(decision).toContain('"customerConfirmsJoined"');
    expect(entry).toBe(renderSkillPrompt(SAV_COLLABORATORS_ENTRY_SKILL));
  });
});

describe("entry skill: principles and fictional examples", () => {
  const rows = SAV_COLLABORATORS_ENTRY_EXAMPLES;
  const single = (verdict: string) => !verdict.includes("+");
  it("has 40 to 60 unique examples and every verdict", () => {
    expect(rows.length).toBe(50);
    expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
    for (const verdict of SAV_COLLABORATORS_ENTRY_VERDICTS) expect(rows.some(row => row.verdict === verdict), verdict).toBe(true);
    for (const family of ["cancellation", "finance", "rights", "identity"]) expect(rows.some(row => row.family === family), family).toBe(true);
    expect(rows.filter(row => row.verdict.includes("+")).length).toBe(4);
  });
  it("has at least 15 reciprocal near pairs with another verdict, covering sensitive, commercial and neighbour twins", () => {
    const pairs = rows.filter(row => row.pair);
    expect(pairs.length).toBeGreaterThanOrEqual(30);
    for (const row of pairs) {
      const twin = rows.find(candidate => candidate.id === row.pair);
      expect(twin?.pair, row.id).toBe(row.id);
      expect(twin!.verdict, row.id).not.toBe(row.verdict);
    }
    const twinsOfBlock = pairs.filter(row => row.verdict === "collaborators").map(row => rows.find(candidate => candidate.id === row.pair)!.verdict);
    for (const verdict of ["sensitive", "commercial", "access", "charly_max", "other"]) expect(twinsOfBlock, verdict).toContain(verdict);
  });
  it("sets a family exactly on sensitive readings; no block example holds a kernel phrase; fictional emails only", () => {
    for (const row of rows) {
      expect(Boolean(row.family), row.id).toBe(row.verdict.includes("sensitive"));
      if (row.verdict === "collaborators") expect(accessSkillKernelHits(row.subject, row.text), row.id).toEqual([]);
      for (const match of `${row.subject} ${row.text}`.matchAll(/[\w.+-]+@[\w.-]+/g)) expect(match[0], row.id).toMatch(/@exemple\.invalid$/);
    }
    expect(rows.filter(row => single(row.verdict) && row.verdict === "collaborators").length).toBeGreaterThanOrEqual(14);
  });
  it("states the rights rule, the decisive question, the doubt rule and the injection rule", () => {
    const text = SAV_COLLABORATORS_ENTRY_GUIDELINES.join("\n");
    for (const words of ["QUESTION DÉCISIVE", "retirer l'accès d'une personne", "transférer la propriété", "Même demandé sous la forme « comment faire »",
      "COMMERCIAL", "DOUTE = ÉQUIPE", "UNE DONNÉE", "PAIRES PROCHES", "SON propre compte", "rubrique Charly Max"]) expect(text, words).toContain(words);
  });
});

describe("decision skill: behaviour, never a procedure", () => {
  const rows = SAV_COLLABORATORS_DECISION_EXAMPLES;
  it("has 40 to 60 unique examples covering every action", () => {
    expect(rows.length).toBe(40);
    expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
    for (const verdict of ["reply", "ask_question", "handoff_support", "handoff_commercial", "no_reply", "propose_resolution"]) {
      expect(rows.some(row => row.verdict === verdict), verdict).toBe(true);
    }
    for (const row of rows.filter(candidate => candidate.pair)) expect(rows.find(candidate => candidate.id === row.pair)?.verdict, row.id).not.toBe(row.verdict);
  });
  it("holds no procedure: no menu path, no delay and no expiry in its guidelines", () => {
    const text = SAV_COLLABORATORS_DECISION_GUIDELINES.join("\n");
    expect(text).not.toMatch(/Paramètres|→|>|\b\d+\s*(?:jours?|heures?|h)\b/);
    for (const words of ["JAMAIS DE PROCÉDURE DE MÉMOIRE", "UNE question", "no_answer_card", "rights_identity", "commercial_seats", "« Transmis » seulement avec un reçu", "« Merci »"]) {
      expect(text, words).toContain(words);
    }
  });
});

describe("strict output schemas", () => {
  const judgment = {
    mail: { sensitive: "none", commercial: "none", instructionLike: false },
    requests: [{ requestId: "r1", verdict: "collaborators", family: null, confidence: "high", quote: "elle n'a rien reçu", reason: "aide à inviter" }],
    sensitiveMentions: [],
  };
  it("accepts a complete entry reading and refuses any drift", () => {
    expect(collaboratorsEntryJudgmentSchema.safeParse(judgment).success).toBe(true);
    for (const bad of [
      { ...judgment, extra: 1 },
      { ...judgment, mail: { sensitive: "none", instructionLike: false } },
      { ...judgment, requests: [{ ...judgment.requests[0], verdict: "yes" }] },
      { ...judgment, requests: [{ ...judgment.requests[0], family: "seats" }] },
      { ...judgment, requests: [] },
    ]) expect(collaboratorsEntryJudgmentSchema.safeParse(bad).success).toBe(false);
  });
  const decision = {
    action: "reply", sources: [{ sourceId: "collaborators.invite-member", contentVersionId: "v1" }], question: null, handoff: null,
    resolution: { customerConfirmsJoined: false, quote: null }, replyPlan: "Parcours d'invitation selon la fiche.",
  };
  it("accepts a coherent decision and refuses incoherent ones", () => {
    expect(collaboratorsDecisionSchema.safeParse(decision).success).toBe(true);
    expect(collaboratorsDecisionSchema.safeParse({ ...decision, action: "ask_question", sources: [], question: "Quel message s'affiche ?" }).success).toBe(true);
    expect(collaboratorsDecisionSchema.safeParse({ ...decision, action: "handoff", sources: [], handoff: { recipient: "commercial", reason: "commercial_seats" } }).success).toBe(true);
    for (const bad of [
      { ...decision, sources: [] },
      { ...decision, action: "ask_question", question: "Quel message ? Et quelle adresse ?" },
      { ...decision, action: "ask_question", question: null },
      { ...decision, question: "Quel message s'affiche ?" },
      { ...decision, action: "handoff", handoff: null },
      { ...decision, handoff: { recipient: "support", reason: "action_requested" } },
      { ...decision, resolution: { customerConfirmsJoined: true, quote: null } },
      { ...decision, handoff: null, extra: true },
    ]) expect(collaboratorsDecisionSchema.safeParse(bad).success).toBe(false);
  });
});
