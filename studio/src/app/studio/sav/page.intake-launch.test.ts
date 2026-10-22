import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach,it,expect,vi } from "vitest";
const mocks=vi.hoisted(()=>({launch:vi.fn(),staff:vi.fn(),redirect:vi.fn(),inbox:vi.fn()}));
vi.mock("@/lib/sav/intake/launch-boundary",()=>({hasIntakeLaunch:mocks.launch}));
vi.mock("@/lib/sav/auth",()=>({requireSavStaff:mocks.staff}));
vi.mock("@/db",()=>({isDatabaseConfigured:()=>true,requireDb:()=>{throw Error("DB_FORBIDDEN");}}));
vi.mock("next/navigation",()=>({redirect:(url:string)=>{mocks.redirect(url);throw Error("REDIRECT");}}));
vi.mock("next/link",()=>({default:(p:ComponentProps<"a">)=>createElement("a",p)}));
vi.mock("./inbox",()=>({SavV0Inbox:()=>{mocks.inbox();return createElement("div",null,"Archives supervisées V0");}}));
vi.mock("./actions",()=>({retryAction:vi.fn(),retryWebhookAction:vi.fn()}));
import Page from "./page";
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv("SAV_RELEASE_STAGE","v0");mocks.staff.mockResolvedValue({});mocks.launch.mockResolvedValue(false);});
it("main SAV preserves V0 without a launch marker",async()=>{expect(renderToStaticMarkup(await Page({searchParams:Promise.resolve({})}))).toContain("Archives supervisées V0");expect(mocks.redirect).not.toHaveBeenCalled();});
it("main SAV opens six-view console after launch while explicit legacy access avoids a redirect loop",async()=>{
  mocks.launch.mockResolvedValue(true);await expect(Page({searchParams:Promise.resolve({})})).rejects.toThrow("REDIRECT");expect(mocks.redirect).toHaveBeenCalledWith("/studio/sav/intake");
  expect(renderToStaticMarkup(await Page({searchParams:Promise.resolve({legacy:"1"})}))).toContain("Archives supervisées V0");
});
