import { createElement, Fragment, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({ staff: vi.fn(), list: vi.fn(), create: vi.fn(), revoke: vi.fn() }));
vi.mock("@/lib/sav/intake/console-auth", () => ({ requireIntakeConsoleStaff: mocks.staff }));
vi.mock("@/lib/mcp/tokens", () => ({ listStudioMcpTokens: mocks.list, createStudioMcpToken: mocks.create, revokeStudioMcpToken: mocks.revoke, STUDIO_MCP_TOKEN: { days: [7, 30, 90], defaultDays: 30 }, STUDIO_MCP_TOKEN_HISTORY: 50 }));
vi.mock("next/link", () => ({ default: (props: ComponentProps<"a">) => createElement("a", props) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import AgentKeysPage from "./page";
import { createAgentKeyAction, revokeAgentKeyAction } from "./actions";

/** Agents access page: one's own keys, prefix only, secret returned once by the creation action. Synthetic data. */
const at = new Date("2026-10-29T10:00:00Z"), later = new Date(Date.now() + 86_400_000);
const staff = { id: "10000000-0000-4000-8000-000000000001", email: "ugo@limova.ai", role: "admin" };
const form = (values: Record<string, string>) => { const data = new FormData(); for (const [k, v] of Object.entries(values)) data.set(k, v); return data; };
beforeEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); mocks.staff.mockResolvedValue(staff);
  mocks.list.mockResolvedValue([{ id: "k1", name: "Claude Code — portable", prefix: "stm_abcdefgh", createdAt: at, expiresAt: later, revokedAt: null, lastUsedAt: at, state: "active" },
    { id: "k2", name: "Ancienne", prefix: "stm_ijklmnop", createdAt: at, expiresAt: later, revokedAt: at, lastUsedAt: null, state: "revoked" }]); });
it("lists the caller's keys by prefix, offers revocation of active keys only, and says when the MCP is off", async () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, await AgentKeysPage()));
  expect(mocks.list).toHaveBeenCalledWith(staff);
  for (const text of ["Claude Code — portable", "stm_abcdefgh…", "active jusqu’au", "révoquée le", "Créer la clé", "Le serveur MCP du Studio est désactivé"]) expect(html).toContain(text);
  expect(html.match(/Révoquer/g)).toHaveLength(1);
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.revoke).not.toHaveBeenCalled();
  vi.stubEnv("STUDIO_MCP_ENABLED", "true");
  expect(renderToStaticMarkup(createElement(Fragment, null, await AgentKeysPage()))).not.toContain("désactivé");
});
it("the creation action returns the secret once, for the authenticated staff member only", async () => {
  mocks.create.mockResolvedValue({ id: "k3", secret: "stm_" + "a".repeat(43) });
  expect(await createAgentKeyAction({ ok: false, message: "" }, form({ name: "Codex", days: "30" }))).toMatchObject({ ok: true, secret: "stm_" + "a".repeat(43) });
  expect(mocks.create).toHaveBeenCalledWith(staff, { name: "Codex", days: 30 });
  mocks.create.mockRejectedValue(Error("SAV_MCP_TOKEN_LIMIT"));
  expect(await createAgentKeyAction({ ok: false, message: "" }, form({ name: "Codex", days: "30" }))).toMatchObject({ ok: false, code: "SAV_MCP_TOKEN_LIMIT" });
  mocks.staff.mockRejectedValue(Error("SAV_INTAKE_CONSOLE_UNAUTHORIZED"));
  expect(await createAgentKeyAction({ ok: false, message: "" }, form({ name: "Codex", days: "30" }))).toMatchObject({ ok: false, code: "SAV_INTAKE_CONSOLE_UNAUTHORIZED" });
  expect(await revokeAgentKeyAction({ ok: false, message: "" }, form({ id: "k1" }))).toMatchObject({ ok: false });
  expect(mocks.revoke).not.toHaveBeenCalled();
});
it("BF05 with more than 50 past keys, every active key keeps its revoke button and the history is separate", async () => {
  const past = Array.from({ length: 50 }, (_, i) => ({ id: `h${i}`, name: `Ancienne ${i}`, prefix: `stm_hist${String(i).padStart(4, "0")}`, createdAt: at, expiresAt: at, revokedAt: at, lastUsedAt: null, state: "revoked" }));
  mocks.list.mockResolvedValue([{ id: "a1", name: "Active originale", prefix: "stm_active01", createdAt: at, expiresAt: later, revokedAt: null, lastUsedAt: null, state: "active" }, ...past]);
  const html = renderToStaticMarkup(createElement(Fragment, null, await AgentKeysPage()));
  expect(html.match(/Révoquer/g)).toHaveLength(1); expect(html).toContain('name="id" value="a1"');
  expect(html.indexOf("Clés actives")).toBeLessThan(html.indexOf("Active originale")); expect(html.indexOf("Active originale")).toBeLessThan(html.indexOf("Historique"));
  expect(html).toContain("Ancienne 49");
});
