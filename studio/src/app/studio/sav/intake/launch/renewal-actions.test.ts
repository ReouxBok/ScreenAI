import { it,expect,vi,beforeEach } from "vitest";
const mocks=vi.hoisted(()=>({preview:vi.fn(),commit:vi.fn(),revalidate:vi.fn()}));
vi.mock("next/cache",()=>({revalidatePath:mocks.revalidate}));
vi.mock("@/lib/sav/intake/launch-admin",()=>({previewIntakeLaunch:vi.fn(),commitIntakeLaunch:vi.fn(),revokeIntakeExecutionPolicy:vi.fn()}));
vi.mock("@/lib/sav/intake/execution-renewal",()=>({previewIntakeExecutionRenewal:mocks.preview,commitIntakeExecutionRenewal:mocks.commit}));
import { previewRenewalAction, commitRenewalAction } from "./actions";
const form=(entries:Record<string,string>)=>{const f=new FormData();for(const [k,v] of Object.entries(entries))f.set(k,v);return f;};
const initial={ok:false,message:""};
beforeEach(()=>vi.clearAllMocks());
it("preview passes only the command id and the typed source id to the server primitive and returns its summary",async()=>{
  const summary={mailboxId:"m",receivedAfter:"r",createdAfter:"c",expiresAt:"e",budgetProfile:null,maxDossiers:7,mutations:["create_ticket"],admission:{kind:"automatic"}};
  mocks.preview.mockResolvedValue({previewId:"p",hash:"h",expiresAt:"x",sourcePolicyId:"s",sourcePolicyHash:"sh",fromCodeRevision:"a",toCodeRevision:"b",summary});
  const state=await previewRenewalAction(initial,form({commandId:"p",sourcePolicyId:"s"}));
  expect(mocks.preview).toHaveBeenCalledWith("p","s");
  expect(state).toMatchObject({ok:true,submittedSource:"s",preview:{id:"p",hash:"h",fromCodeRevision:"a",toCodeRevision:"b",summary}});
});
it("refusals keep the exact SAV code with a neutral label; oversized input never reaches the server primitive",async()=>{
  mocks.preview.mockRejectedValue(Error("SAV_INTAKE_RENEWAL_SOURCE_REVOKED"));
  expect(await previewRenewalAction(initial,form({commandId:"p",sourcePolicyId:"s"}))).toMatchObject({ok:false,code:"SAV_INTAKE_RENEWAL_SOURCE_REVOKED",message:expect.stringContaining("Vérifiez le diagnostic")});
  mocks.preview.mockClear();
  expect(await previewRenewalAction(initial,form({commandId:"p",sourcePolicyId:"x".repeat(101)}))).toMatchObject({ok:false,code:"SAV_INTAKE_ADMIN_INPUT_TOO_LARGE"});
  expect(mocks.preview).not.toHaveBeenCalled();
  mocks.commit.mockRejectedValue(Object.assign(Error("raw driver detail"),{}));
  expect(await commitRenewalAction(initial,form({previewId:"p",hash:"h"}))).toMatchObject({ok:false,code:"SAV_INTAKE_ADMIN_INVALID_COMMAND"});
});
it("commit returns the new policy id and hash for the canonical configuration and changes no server variable",async()=>{
  const receipt={policyId:"n",policyHash:"nh",sourcePolicyId:"s",sourcePolicyHash:"sh",fromCodeRevision:"a",toCodeRevision:"b"};
  mocks.commit.mockResolvedValue(receipt);
  const state=await commitRenewalAction(initial,form({previewId:"p",hash:"h"}));
  expect(mocks.commit).toHaveBeenCalledWith("p","h");
  expect(state).toMatchObject({ok:true,receipt,message:expect.stringContaining("Aucune variable serveur n’a été modifiée")});
  expect(mocks.revalidate).toHaveBeenCalledWith("/studio/sav/intake");
});
it("review M-1: a commit failing after the approval (lost lease or receipt write) claims no non-effect, points to the same command and leaks no driver detail",async()=>{
  const noClaim=(message:string)=>{expect(message).not.toMatch(/aucune politique|n’a été créée|n'a été créée|ni modifiée|aucun effet/i);expect(message).toContain("reprenez la même commande");expect(message).toContain("état des politiques");};
  mocks.commit.mockRejectedValue(Error("SAV_INTAKE_RENEWAL_PREVIEW_CONFLICT"));
  const lost=await commitRenewalAction(initial,form({previewId:"p",hash:"h"}));
  expect(lost).toMatchObject({ok:false,code:"SAV_INTAKE_RENEWAL_PREVIEW_CONFLICT"});expect(lost.receipt).toBeUndefined();noClaim(lost.message);
  mocks.commit.mockRejectedValue(Error("duplicate key value violates unique constraint \"intake_execution_policies_pkey\" (synthetic driver detail)"));
  const receiptWrite=await commitRenewalAction(initial,form({previewId:"p",hash:"h"}));
  expect(receiptWrite).toMatchObject({ok:false,code:"SAV_INTAKE_ADMIN_INVALID_COMMAND"});expect(receiptWrite.receipt).toBeUndefined();noClaim(receiptWrite.message);
  expect(JSON.stringify(receiptWrite)).not.toMatch(/duplicate key|intake_execution_policies_pkey|synthetic driver detail/);
  expect(mocks.commit).toHaveBeenCalledTimes(2);expect(mocks.revalidate).not.toHaveBeenCalled();
});
