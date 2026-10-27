import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { it, expect, vi, beforeEach } from "vitest";
const mocks = vi.hoisted(() => ({ banner: vi.fn(), panel: vi.fn(), set: vi.fn() }));
vi.mock("@/lib/sav/intake/agent-pause-admin", () => ({ readSavAgentPauseBanner: mocks.banner, readSavAgentPausePanel: mocks.panel }));
vi.mock("./pause/actions", () => ({ setPauseAction: mocks.set }));
vi.mock("next/link", () => ({ default: (props: ComponentProps<"a">) => createElement("a", props) }));
import { AgentPauseBanner } from "./agent-pause-banner";
import PausePage from "./pause/page";
const setting = { revision: "sav-agent-pause.v1", agent: "intake", level: "fully_paused", setBy: "reouven@limova.ai", setAt: "2026-10-27T08:00:00.000Z", reason: "Incident CRM" };
beforeEach(() => { vi.clearAllMocks(); });

it("console banner says since when, by whom and which level, with the pause link for administrators only", async () => {
  mocks.banner.mockResolvedValue({ level: "fully_paused", setBy: "reouven@limova.ai", setAt: "2026-10-27T08:00:00.000Z", invalid: false });
  const admin = renderToStaticMarkup(await AgentPauseBanner({ role: "admin" }));
  for (const text of ["Agent en pause depuis 27/10/2026 09:00 par reouven@limova.ai — niveau pause complète", "Gérer la pause", "/studio/sav/intake/pause"]) expect(admin).toContain(text);
  expect(admin).not.toContain("Incident CRM");
  const member = renderToStaticMarkup(await AgentPauseBanner({ role: "member" }));
  expect(member).toContain("niveau pause complète"); expect(member).not.toContain("/studio/sav/intake/pause");
  mocks.banner.mockResolvedValue({ level: "actions_paused", setBy: "reouven@limova.ai", setAt: "2026-10-27T08:00:00.000Z", invalid: false });
  expect(renderToStaticMarkup(await AgentPauseBanner({ role: "member" }))).toContain("niveau actions suspendues (l’analyse continue");
});
it("running: nothing for members, a pause link for administrators; unreadable state shows a full pause with its code", async () => {
  mocks.banner.mockResolvedValue(null);
  expect(await AgentPauseBanner({ role: "member" })).toBeNull();
  expect(renderToStaticMarkup(await AgentPauseBanner({ role: "owner" }))).toContain("Mettre l’agent en pause");
  mocks.banner.mockRejectedValue(Error("SAV_ENCRYPTION_KEY_REQUIRED"));
  expect(renderToStaticMarkup(await AgentPauseBanner({ role: "member" }))).toContain("SAV_INTAKE_AGENT_PAUSE_INVALID");
});
it("pause page shows the current state, the three levels with a mandatory reason, and the history, inert on GET", async () => {
  mocks.panel.mockResolvedValue({ state: { level: "fully_paused", setting, invalid: false },
    history: [{ at: "2026-10-27T08:00:00.000Z", actor: "reouven@limova.ai", previousLevel: "running", nextLevel: "fully_paused", reason: "Incident CRM" }] });
  const html = renderToStaticMarkup(await PausePage());
  for (const text of ["Pause de l’agent", "pause complète (ni analyse", "27/10/2026 09:00 par reouven@limova.ai", "Incident CRM", "Agent actif", "Suspendre les actions", "Pause complète (actuel)",
    "required", "agent actif → pause complète"]) expect(html).toContain(text);
  expect(mocks.set).not.toHaveBeenCalled();
});
it("pause page warns about an unreadable setting; a non-administrator is refused", async () => {
  mocks.panel.mockResolvedValue({ state: { level: "fully_paused", setting: null, invalid: true }, history: [] });
  expect(renderToStaticMarkup(await PausePage())).toContain("SAV_INTAKE_AGENT_PAUSE_INVALID");
  mocks.panel.mockRejectedValue(Error("SAV_AGENT_PAUSE_UNAUTHORIZED"));
  await expect(PausePage()).rejects.toThrow("SAV_AGENT_PAUSE_UNAUTHORIZED");
});
