// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ preview: vi.fn(), commit: vi.fn() }));
vi.mock("./continuity-client", async original => ({ ...await original<typeof import("./continuity-client")>(), continuityPreview: mocks.preview, continuityCommit: mocks.commit }));
import { ContinuityAdminForm } from "./continuity-form";
const source = "10000000-0000-4000-8000-000000000001", execution = "20000000-0000-4000-8000-000000000001";
const preview = { sourcePolicyId: source, targetPolicyId: "10000000-0000-4000-8000-000000000002", executionIds: [execution], hash: "a".repeat(64) };
let container: HTMLDivElement, root: Root;
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); mocks.preview.mockResolvedValue(preview);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => { root.render(createElement(ContinuityAdminForm)); });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function fill(selector: string, value: string) {
  const input = container.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
  const prototype = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function prepare() {
  await fill("#continuity-source", source); await fill("#continuity-executions", execution);
  await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}
it("mount is inert and confirmation requires a preview and explicit drain check", async () => {
  expect(mocks.preview).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled();
  await prepare(); expect(mocks.preview).toHaveBeenCalledExactlyOnceWith({ sourcePolicyId: source, executionIds: [execution] });
  expect((container.querySelector('button[type="button"]') as HTMLButtonElement).disabled).toBe(true);
});
it("editing the selection invalidates the preview and attestation", async () => {
  await prepare(); await fill("#continuity-source", "10000000-0000-4000-8000-000000000003");
  expect(container.querySelector('button[type="button"]')).toBeNull(); expect(mocks.commit).not.toHaveBeenCalled();
});
it("double click sends a single commit and remains locked after confirmation", async () => {
  let resolve!: (value: unknown) => void; mocks.commit.mockImplementation(() => new Promise(r => { resolve = r; }));
  await prepare(); await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
  const button = container.querySelector('button[type="button"]') as HTMLButtonElement;
  await act(async () => { button.click(); button.click(); }); expect(mocks.commit).toHaveBeenCalledTimes(1);
  await act(async () => { resolve({ id: "30000000-0000-4000-8000-000000000001", executionIds: [execution] }); });
  expect(button.disabled).toBe(true); expect(container.textContent).toContain("Reçu de continuité");
  await act(async () => button.click()); expect(mocks.commit).toHaveBeenCalledTimes(1);
});
it("a lost response blocks another POST and requires audit verification", async () => {
  mocks.commit.mockRejectedValue(Error("response lost")); await prepare();
  await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
  await act(async () => (container.querySelector('button[type="button"]') as HTMLButtonElement).click());
  expect(container.textContent).toContain("Résultat du transfert incertain");
  expect((container.querySelector('button[type="button"]') as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.commit).toHaveBeenCalledTimes(1);
});
