import { renderToStaticMarkup } from "react-dom/server";
import { it,expect,vi,beforeEach } from "vitest";
const mocks=vi.hoisted(()=>({admin:vi.fn(),preview:vi.fn(),commit:vi.fn(),revoke:vi.fn(),renewPreview:vi.fn(),renewCommit:vi.fn()}));
vi.mock("@/lib/sav/intake/execution-policy",()=>({executionAdministrator:mocks.admin}));
vi.mock("./actions",()=>({previewLaunchAction:mocks.preview,commitLaunchAction:mocks.commit,revokeLaunchAction:mocks.revoke,previewRenewalAction:mocks.renewPreview,commitRenewalAction:mocks.renewCommit}));
import Page from "./page";
beforeEach(()=>{vi.clearAllMocks();mocks.admin.mockResolvedValue({role:"admin"});});
it("administrator panel is reachable with a private JSON input and explicit separate confirmations, inert on GET",async()=>{
  const html=renderToStaticMarkup(await Page());expect(html).toContain("Configuration JSON privée");expect(html).toContain("Préparer un nouvel aperçu");expect(html).toContain("Révoquer cette autorité");
  expect(html).not.toContain("Confirmer la frontière et la politique");expect(mocks.admin).toHaveBeenCalledTimes(1);expect(mocks.preview).not.toHaveBeenCalled();expect(mocks.commit).not.toHaveBeenCalled();expect(mocks.revoke).not.toHaveBeenCalled();
  expect(html).toContain("Préparer l’aperçu de continuité");expect(html).toContain("Identifiants des exécutions (100 maximum)");
  expect(html).not.toContain("Confirmer ce transfert exact");
});
it("inactive or unauthenticated administrator cannot read the launch panel",async()=>{mocks.admin.mockRejectedValue(Error("SAV_INTAKE_EXECUTION_UNAUTHORIZED"));await expect(Page()).rejects.toThrow("UNAUTHORIZED");});
it("renewal form is present next to the existing forms: one optional source id, no JSON or payload, no confirmation before a preview, inert on GET",async()=>{
  const html=renderToStaticMarkup(await Page());
  expect(html).toContain("Renouveler une autorité existante");expect(html).toContain("Préparer l’aperçu de renouvellement");
  expect(html).toContain("Identifiant de la politique source (vide : politique configurée côté serveur)");expect(html).toContain('name="sourcePolicyId"');
  expect(html).not.toContain("Confirmer ce renouvellement exact");
  expect(html.match(/<textarea/g)).toHaveLength(3);
  expect(html).toContain("Configuration JSON privée");expect(html).toContain("Révoquer cette autorité");expect(html).toContain("Préparer l’aperçu de continuité");
  expect(mocks.renewPreview).not.toHaveBeenCalled();expect(mocks.renewCommit).not.toHaveBeenCalled();
});
