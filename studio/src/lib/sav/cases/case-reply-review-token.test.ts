import { describe, expect, it } from "vitest";
import { describeCaseReplyReview } from "@/app/studio/sav/v2/case-replies";
import { caseReplyReviewSensitive, encodeCaseReplyReviewToken, parseCaseReplyReviewToken } from "./case-reply-review-token";
import { caseReplyTextSafetyProblems } from "./decision-validator";
import type { CaseSnapshot } from "./case-types";
import { SAV_CASE_ACCESS_URL } from "./decision-contract";

// SAV-92, pure parts: the version token, the sensitive guard, the corrected-text rules shared with the automatic path, the administrator's messages.
const id = "30000000-0000-4000-8000-000000000001", hash = "a".repeat(64);

describe("version token", () => {
  it("round-trips exactly and refuses anything else", () => {
    const token = encodeCaseReplyReviewToken({ validationId: id.toUpperCase(), payloadHash: hash, caseVersion: 7 });
    expect(parseCaseReplyReviewToken(token)).toEqual({ validationId: id, payloadHash: hash, caseVersion: 7 });
    for (const bad of [null, 7, "", `v2.${id}.${hash}.7`, `v1.${id}.${hash}.0`, `v1.${id}.${hash}.-1`, `v1.${id}.${"g".repeat(64)}.7`, `v1.${id}.${hash}.7.extra`, `v1.x.${hash}.7`, "v1." + "a".repeat(300)])
      expect(parseCaseReplyReviewToken(bad)).toBeNull();
  });
});

describe("sensitive guard", () => {
  const base = { sensitivity: "none", admission: null, body: { openRequests: [{ id: "r", summary: "s", family: "access", status: "open", openedAt: "2026-11-01T00:00:00.000Z" }] } } as unknown as Pick<CaseSnapshot, "sensitivity" | "body" | "admission">;
  it("finance, cancellation or any sensitive family (open request or admission) is sensitive; an Access case is not", () => {
    expect(caseReplyReviewSensitive(base)).toBe(false);
    expect(caseReplyReviewSensitive({ ...base, sensitivity: "finance" })).toBe(true);
    expect(caseReplyReviewSensitive({ ...base, sensitivity: "cancellation" })).toBe(true);
    expect(caseReplyReviewSensitive({ ...base, body: { ...base.body, openRequests: [{ ...base.body.openRequests[0]!, family: "identity" }] } })).toBe(true);
    expect(caseReplyReviewSensitive({ ...base, admission: { sensitivity: "none", families: ["access", "rights"] } as unknown as CaseSnapshot["admission"] })).toBe(true);
  });
});

describe("corrected text: the automatic path's text rules", () => {
  const access = { accessOpen: true, answersOrAsks: true };
  it("refuses a request for a secret, in French and English, whatever the case", () => {
    expect(caseReplyTextSafetyProblems("Pouvez-vous nous transmettre votre code de vérification ?", { accessOpen: false, answersOrAsks: true })).toEqual([{ code: "credential_request_pattern" }]);
    expect(caseReplyTextSafetyProblems("Please send us your password.", { accessOpen: false, answersOrAsks: true })).toEqual([{ code: "credential_request_pattern" }]);
    expect(caseReplyTextSafetyProblems("Ne communiquez jamais votre mot de passe.", { accessOpen: false, answersOrAsks: true })).toEqual([]);
  });
  it("Access open: the official link is required and any other link or look-alike name is refused", () => {
    expect(caseReplyTextSafetyProblems(`Connectez-vous sur ${SAV_CASE_ACCESS_URL} puis réessayez.`, access)).toEqual([]);
    expect(caseReplyTextSafetyProblems("Connectez-vous puis réessayez.", access)).toEqual([{ code: "access_link_missing" }]);
    expect(caseReplyTextSafetyProblems(`Allez sur ${SAV_CASE_ACCESS_URL} ou https://evil.example.invalid/login`, access)).toEqual([{ code: "access_link_invalid", detail: "https://evil.example.invalid/login" }]);
    expect(caseReplyTextSafetyProblems(`Allez sur ${SAV_CASE_ACCESS_URL} ou app.limova.fr`, access)).toEqual([{ code: "access_link_invalid", detail: "app.limova.fr" }]);
    // No Access request open: the automatic path has no link rule, neither has the correction.
    expect(caseReplyTextSafetyProblems("Voir https://academy.example.invalid", { accessOpen: false, answersOrAsks: true })).toEqual([]);
  });
});

describe("what the administrator reads", () => {
  it("success, refusals with the validator's reasons, approved-but-not-queued and uncertain results; never claims a send", () => {
    expect(describeCaseReplyReview({ ok: true, action: "approve", send: "attempted" })).toMatchObject({ tone: "success", text: expect.stringContaining("Une seule réponse par mail") });
    expect(describeCaseReplyReview({ ok: true, action: "approve", send: "catch_up" }).text).toContain("prochain passage automatique");
    expect(describeCaseReplyReview({ ok: true, action: "decline", handoff: "done" }).text).toBe("Refus enregistré, rien n’est parti. Le dossier est confié à l’équipe.");
    expect(describeCaseReplyReview({ ok: true, action: "decline", handoff: "failed" }).tone).toBe("warning");
    expect(describeCaseReplyReview({ ok: false, code: "text_refused", problems: [{ code: "credential_request_pattern" }, { code: "access_link_invalid", detail: "https://x.example.invalid" }] }).text)
      .toBe("Le texte corrigé est refusé par les contrôles de sécurité de l’envoi automatique : le texte demande un mot de passe, un code ou un autre secret ; lien ou nom de domaine non autorisé : https://x.example.invalid. Rien n’a été envoyé.");
    expect(describeCaseReplyReview({ ok: false, code: "case_version_changed" }).text).toContain("Actualisez la page. Rien n’a été envoyé.");
    expect(describeCaseReplyReview({ ok: false, code: "sensitive" }).text).toContain("aucun envoi depuis ce bouton");
    expect(describeCaseReplyReview({ ok: false, code: "owner_unread", approvedValidationId: id }).text).toMatch(/^Validation enregistrée, mais la mise en file a été refusée .* Rien n’est parti\.$/);
    expect(describeCaseReplyReview({ ok: false, code: "review_unconfirmed" })).toMatchObject({ tone: "warning", text: expect.not.stringContaining("Rien n’a été envoyé") });
    expect(describeCaseReplyReview({ ok: false, code: "future_code" }).text).toBe("Action refusée (code future_code). Rien n’a été envoyé.");
  });
});
