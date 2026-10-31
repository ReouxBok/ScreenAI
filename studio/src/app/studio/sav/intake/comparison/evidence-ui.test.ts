/** SAV-46: the one-dossier receipt page. Synthetic receipt; the operator layer is mocked. */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ evidence: vi.fn(), attest: vi.fn() }));
vi.mock("@/lib/sav/intake/comparison-operator", () => ({ readIntakeComparisonEvidence: m.evidence }));
vi.mock("./actions", () => ({ attestComparisonAction: m.attest }));
import EvidencePage from "./[messageId]/page";
const mid = "10000000-0000-4000-8000-000000000001", sha = "a".repeat(64);
const detail = (over: Record<string, unknown> = {}) => ({ campaignId: "synthetic-60", messageId: mid, claimId: "30000000-0000-4000-8000-000000000001", state: "done", verdict: "identical",
  qualificationEvidence: "complete", verification: { ok: true, reason: null }, attestation: null, detail: { evidence: { receiptSha256: sha } },
  receipt: { common: { source: { engineInput: { message: { currentText: "<script>alert(1)</script><a href=\"https://example.invalid/x\">SYN lien</a>" } } } } }, ...over });
const render = async () => renderToStaticMarkup(await EvidencePage({ params: Promise.resolve({ messageId: mid }) }));
beforeEach(() => vi.clearAllMocks());
it("renders the receipt as escaped text, with no customer, ticket or mailbox action", async () => {
  m.evidence.mockResolvedValue(detail());
  const html = await render();
  expect(m.evidence).toHaveBeenCalledWith(mid);
  expect(html).not.toContain("<script>"); expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain('href="https://example.invalid/x"');
  expect(html).toContain(sha); expect(html).toContain("ce n’est pas un jugement métier");
  // The only form records an attestation; nothing sends, replies, creates or assigns.
  expect(html.match(/<form/g)).toHaveLength(1); expect(html).toContain('name="oracleSha256"'); expect(html).toContain(`value="${sha}"`);
  expect(html).not.toMatch(/Envoyer|Répondre|Créer le ticket|Assigner|Exécuter/);
  expect(m.attest).not.toHaveBeenCalled();
});
it.each([["legacy", { qualificationEvidence: "legacy", verification: null, receipt: null, detail: { coverage: [] } }], ["tampered", { qualificationEvidence: "invalid", verification: { ok: false, reason: "receipt_sha256_mismatch" }, receipt: null }],
  ["already attested", { attestation: { claimId: "c", receiptSha256: sha, oracleSha256: "b".repeat(64), outcome: "matches_oracle", at: "x" } }]] as const)("offers no attestation for a %s receipt", async (_name, over) => {
  m.evidence.mockResolvedValue(detail(over));
  expect(await render()).not.toContain("<form");
});
it("a denied session renders nothing", async () => {
  m.evidence.mockRejectedValue(Error("SAV_INTAKE_COMPARISON_UNAUTHORIZED"));
  await expect(render()).rejects.toThrow("UNAUTHORIZED");
});
