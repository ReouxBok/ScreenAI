import { describe, expect, it, vi } from "vitest";
import { SAV_CASE_BLOCK_REGISTRY } from "../cases/case-block-registry";
import { caseBlockCandidates } from "../cases/case-blocks";
import { firstPersonalLoginRequest } from "../cases/investigation-return-qualify";
import { savBlockManifestProblems } from "./block-attribution";
import { runSavBlockReplay } from "./block-replay";
import { SAV_FOLLOWUPS_BLOCK } from "./followups-block";
import { decideSavFollowup, type FollowupsContext } from "./followups-decision";
import { SAV_FOLLOWUPS_INDEX_PHRASES, SAV_FOLLOWUPS_TEST_PHRASES } from "./followups-phrases";

const proven: FollowupsContext = {
  mode: "shadow", historyComplete: true,
  review: { fullMessageReviewed: true, newRequest: false, sensitive: false, persistentProblem: false },
  needs: [{ id: "syn-need", status: "resolved", evidence: { ref: "syn-verified-result", verified: true } }],
};

describe("SAV-92 followups: offline and unregistered", () => {
  it("is off, has no cards and cannot enter live admission", () => {
    expect(SAV_FOLLOWUPS_BLOCK.mode).toBe("off");
    expect(SAV_FOLLOWUPS_BLOCK.cardIds).toEqual([]);
    expect(SAV_FOLLOWUPS_BLOCK.supportCardIds).toEqual([]);
    expect(SAV_CASE_BLOCK_REGISTRY.map(row => [row.blockId, row.family])).toEqual([["access", "access"]]);
    expect(SAV_CASE_BLOCK_REGISTRY[0]!.firstRequest).toBe(firstPersonalLoginRequest);
    expect(caseBlockCandidates([{ blockId: "followups", ruleId: "syn-followups", revision: "syn", family: "usage",
      v1Kind: "support", at: "2026-11-16T09:00:00Z" }], SAV_CASE_BLOCK_REGISTRY)).toEqual([]);
    expect(savBlockManifestProblems([SAV_FOLLOWUPS_BLOCK])).toEqual([{ code: "card_list_empty", blockId: "followups" }]);
  });

  it("refuses replay before search with no published cards", async () => {
    const search = vi.fn(async () => { throw Error("NO_SEARCH"); });
    await expect(runSavBlockReplay([], { blocks: [SAV_FOLLOWUPS_BLOCK], now: new Date("2026-11-16T09:00:00Z") },
      { search: { readRevision: async () => "syn", search } })).rejects.toThrow("card_list_empty:followups");
    expect(search).not.toHaveBeenCalled();
  });

  it("excludes all 10 reserved phrases from the 20 index phrases", () => {
    const reserved = SAV_FOLLOWUPS_TEST_PHRASES.filter(row => row.split === "holdout");
    expect([SAV_FOLLOWUPS_INDEX_PHRASES.length, reserved.length]).toEqual([20, 10]);
    expect(new Set(SAV_FOLLOWUPS_TEST_PHRASES.map(row => row.id)).size).toBe(30);
    expect(new Set(SAV_FOLLOWUPS_TEST_PHRASES.map(row => row.text)).size).toBe(30);
    for (const row of reserved) {
      expect(SAV_FOLLOWUPS_INDEX_PHRASES).not.toContain(row);
      expect(SAV_FOLLOWUPS_INDEX_PHRASES.map(item => item.text).join("\n")).not.toContain(row.text);
    }
  });
});

describe("pure followup decisions, never ticket closure", () => {
  it.each(SAV_FOLLOWUPS_TEST_PHRASES)("$id [$split]: $expected", row => {
    // Deliberately optimistic assessments: adverse full-message content must still prevent a proposal.
    expect(decideSavFollowup(row.text, proven).action).toBe(row.expected);
  });

  it("keeps absent and explicit off settings disabled even with evidence", () => {
    expect(decideSavFollowup("Merci")).toEqual({ action: "no_action", reason: "block_off" });
    for (const mode of [undefined, "off"] as const) {
      expect(decideSavFollowup("Merci", { ...proven, mode })).toEqual({ action: "no_action", reason: "block_off" });
    }
  });

  it("a thank-you alone supplies no resolution evidence", () => {
    expect(decideSavFollowup("Merci", { ...proven, needs: undefined })).toEqual({ action: "no_action", reason: "unresolved_or_unproven" });
  });

  it("hands off false thanks, hidden requests and sensitive topics with a reason", () => {
    expect(decideSavFollowup("Merci mais toujours bloqué", proven)).toEqual({ action: "handoff", reason: "ambiguous_message" });
    expect(decideSavFollowup("Merci, et sinon comment exporter mes documents ?", proven)).toEqual({ action: "handoff", reason: "ambiguous_message" });
    for (const text of ["Merci, et sinon pour la facture…", "Merci, je résilie"]) {
      expect(decideSavFollowup(text, proven)).toEqual({ action: "handoff", reason: "sensitive" });
    }
  });

  it.each([
    undefined, [],
    [{ id: "syn", status: "open" as const }],
    [{ id: "syn", status: "resolved" as const }],
    [{ id: "syn", status: "resolved" as const, evidence: { ref: "syn", verified: false } }],
    [{ id: "syn", status: "resolved" as const, evidence: { ref: " ", verified: true } }],
    [{ id: " ", status: "resolved" as const, evidence: { ref: "syn", verified: true } }],
    [...proven.needs!, { id: "syn-open", status: "open" as const }],
    [...proven.needs!, ...proven.needs!],
  ].map(needs => ({ needs })))("requires proof for every distinct known need (%#)", ({ needs }) => {
    expect(decideSavFollowup("C'est bon merci", { ...proven, needs }).action).toBe("no_action");
  });

  it.each([undefined, false])("requires complete history (%s)", historyComplete => {
    expect(decideSavFollowup("Merci", { ...proven, historyComplete })).toEqual({ action: "handoff", reason: "history_incomplete" });
  });

  it.each([undefined, { ...proven.review!, fullMessageReviewed: false }])("requires full review (%#)", review => {
    expect(decideSavFollowup("Merci", { ...proven, review })).toEqual({ action: "handoff", reason: "review_incomplete" });
  });

  it.each([
    ["newRequest", "new_request"], ["sensitive", "sensitive"], ["persistentProblem", "persistent_problem"],
  ] as const)("honours contextual %s even in a short thank-you", (flag, reason) => {
    expect(decideSavFollowup("Merci", { ...proven, review: { ...proven.review!, [flag]: true } })).toEqual({ action: "handoff", reason });
  });

  it("does not hide a request behind punctuation, a signature, a quote or an attachment marker", () => {
    for (const suffix of ["\nPS : autre question", "\nCordialement\nNouvelle demande", "\n> Ma facture ?", "\n[pièce jointe non lue]"]) {
      expect(decideSavFollowup(`Merci.${suffix}`, proven).action).toBe("handoff");
    }
  });

  it("returns only a proposal with all gates met, including in automatic simulation", () => {
    expect(decideSavFollowup("C'est bon merci", proven)).toEqual({ action: "close_proposal", reason: "resolution_proven" });
    expect(decideSavFollowup("Merci", { ...proven, mode: "automatic" })).toEqual({ action: "close_proposal", reason: "resolution_proven" });
  });

  it("never proposes closure for an acknowledgement of future work or missing news", () => {
    for (const text of ["Je reviens vers vous", "Pas de nouvelles"]) {
      expect(decideSavFollowup(text, proven)).toEqual({ action: "no_action", reason: "awaiting_customer" });
    }
  });
});

describe("Access detector boundary remains unchanged", () => {
  it.each(SAV_FOLLOWUPS_TEST_PHRASES)("$id [$split]: access=$access", row => {
    expect(firstPersonalLoginRequest(row.text, "")).toBe(row.access);
  });
});
