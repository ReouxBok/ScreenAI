import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
// SAV-19 / V2 pilot: the console header reaches the existing knowledge pages and the read-only V2 pilot (navigation only)
// for every role that can open the console; role-gated links stay gated.
const mocks = vi.hoisted(() => ({ staff: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/sav/intake/console-auth", () => ({ requireIntakeConsoleStaff: mocks.staff }));
vi.mock("@/lib/sav/intake/console-store", () => ({ listIntakeConsole: mocks.list }));
vi.mock("./agent-pause-banner", () => ({ AgentPauseBanner: () => null }));
vi.mock("./navigation", () => ({ IntakeListPosition: () => null, IntakeDossierLink: (props: ComponentProps<"a">) => createElement("a", props) }));
vi.mock("next/link", () => ({ default: (props: ComponentProps<"a">) => createElement("a", props) }));
import IntakeConsolePage from "./page";

beforeEach(() => { vi.clearAllMocks(); mocks.list.mockResolvedValue({ installed: false, counts: {}, rows: [], page: 1, pages: 1 }); });
const render = async () => renderToStaticMarkup(await IntakeConsolePage({ searchParams: Promise.resolve({}) }));

it.each(["member", "admin", "owner"])("%s sees the knowledge entry next to the archives, with no write on render", async role => {
  mocks.staff.mockResolvedValue({ email: "operateur@example.test", role });
  const html = await render();
  expect(html).toContain('href="/studio/sav/connaissances">Connaissances</a>');
  expect(html).toContain('href="/studio/sav/v2">Pilote V2</a>');
  expect(html).toContain('href="/studio/sav?legacy=1">Archives supervisées</a>');
  expect(html.includes("/studio/sav/intake/launch")).toBe(role !== "member");
  expect(html.includes("/studio/sav/intake/comparison")).toBe(role === "admin");
});
it("refused access renders nothing (the guard runs before any link)", async () => {
  mocks.staff.mockRejectedValue(Error("SAV_INTAKE_CONSOLE_UNAUTHORIZED"));
  await expect(render()).rejects.toThrow("SAV_INTAKE_CONSOLE_UNAUTHORIZED");
  expect(mocks.list).not.toHaveBeenCalled();
});
