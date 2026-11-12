import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ panel: vi.fn(), set: vi.fn() }));
vi.mock("@/lib/sav/cases/block-switch-admin", () => ({ readSavBlockSwitchPanel: mocks.panel }));
vi.mock("./blocks/actions", () => ({ setBlockSwitchAction: mocks.set }));
vi.mock("next/link", () => ({ default: (props: ComponentProps<"a">) => createElement("a", props) }));
import BlocksPage from "./blocks/page";
beforeEach(() => { vi.clearAllMocks(); });

it("blocks page shows each block's mode, pause, effective state against the global switch, a mandatory reason and the history; inert on GET, no budget", async () => {
  mocks.panel.mockResolvedValue({ globalAutoReply: false, blocks: [{ blockId: "access", mode: "auto", paused: false, invalid: false, effective: "draft",
    setting: { revision: "sav-block-switch.v1", blockId: "access", mode: "auto", paused: false, setBy: "admin@example.invalid", setAt: "2026-11-12T08:00:00.000Z", reason: "Retour normal" },
    history: [{ at: "2026-11-12T08:00:00.000Z", actor: "admin@example.invalid", previous: "draft+paused", next: "auto", reason: "Retour normal" }] }] });
  const html = renderToStaticMarkup(await BlocksPage());
  for (const text of ["Blocs de traitement", "Accès (connexion)", "Interrupteur global de réponse automatique : <strong>désactivé</strong>", "État effectif</dt><dd>brouillon",
    "Arrêt", "Brouillon", "Automatique (actuel)", "Pause du bloc", "required", "12/11/2026 09:00 par admin@example.invalid", "brouillon + en pause → automatique · Retour normal"])
    expect(html).toContain(text);
  expect(html).not.toMatch(/USD|budget/i);
  expect(mocks.set).not.toHaveBeenCalled();
});
it("an unreadable setting is shown as stopped for safety; a non-administrator is refused", async () => {
  mocks.panel.mockResolvedValue({ globalAutoReply: true, blocks: [{ blockId: "access", mode: "off", paused: false, invalid: true, effective: "off", setting: null, history: [] }] });
  const html = renderToStaticMarkup(await BlocksPage());
  for (const text of ["block_setting_invalid", "réglage illisible", "Aucun changement enregistré."]) expect(html).toContain(text);
  mocks.panel.mockRejectedValue(Error("SAV_BLOCK_SWITCH_UNAUTHORIZED"));
  await expect(BlocksPage()).rejects.toThrow("SAV_BLOCK_SWITCH_UNAUTHORIZED");
});
