import { expect, it } from "vitest";
import { savSemanticE2eProposal } from "../../../test/sav-semantic-e2e-fixture";
import { savDossierSourceHash, savDraftSourceHash } from "./review-contract";

it("normalizes model request IDs while preserving material fact bindings in both verdict hashes", () => {
  const proposal = savSemanticE2eProposal();
  proposal.understanding!.requests.push({ ...proposal.understanding!.requests[0], id: "request-2" });
  proposal.understanding!.knownFacts[0].requestIds = ["request-1"];
  proposal.understanding!.attemptedSteps[0].requestIds = ["request-1"];
  const renamed = JSON.parse(JSON.stringify(proposal).replace(/request-[12]/g, id => `renamed-${id}`)) as typeof proposal;
  for (const hash of [savDossierSourceHash, savDraftSourceHash]) expect(hash(renamed)).toBe(hash(proposal));
  const changed = structuredClone(proposal); changed.understanding!.knownFacts[0].requestIds = ["request-2"];
  for (const hash of [savDossierSourceHash, savDraftSourceHash]) expect(hash(changed)).not.toBe(hash(proposal));
  proposal.understanding!.knownFacts[0].requestIds = ["request-1", "request-2"];
  changed.understanding!.knownFacts[0].requestIds = ["request-2", "request-1"];
  for (const hash of [savDossierSourceHash, savDraftSourceHash]) expect(hash(changed)).toBe(hash(proposal));
});
