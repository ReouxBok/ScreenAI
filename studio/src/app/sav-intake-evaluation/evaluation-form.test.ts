// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import EvaluationForm from "./evaluation-form";
let container: HTMLDivElement, root: Root;
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function mount() { await act(async () => root.render(createElement(EvaluationForm))); }
it("does not fetch or launch at render and disables start without a file", async () => {
  const network = vi.fn(); vi.stubGlobal("fetch", network); await mount(); expect(network).not.toHaveBeenCalled(); expect(container.querySelector("button")?.disabled).toBe(true);
});
it("GET status is passive and private response text is escaped", async () => {
  const network = vi.fn(async () => ({ json: async () => ({ state: "complete", text: "<img src=x onerror=alert(1)>" }) })); vi.stubGlobal("fetch", network); await mount();
  await act(async () => container.querySelectorAll("button")[1].click());
  expect(network.mock.calls[0]).toEqual(["/api/internal/sav/intake-evaluation", expect.objectContaining({ method: "GET", cache: "no-store", credentials: "same-origin" })]);
  expect(container.querySelector("img")).toBeNull(); expect(container.textContent).toContain("<img src=x");
});
it("uploads exactly the selected bytes only on explicit start, then locks the busy buttons", async () => {
  let finish!: () => void;
  const network = vi.fn(() => new Promise(resolve => { finish = () => resolve({ json: async () => ({ state: "complete" }) }); })); vi.stubGlobal("fetch", network); await mount();
  const input = container.querySelector("input")!, file = new File(["{\"version\":1}"], "private.json", { type: "application/json" });
  Object.defineProperty(file, "text", { value: async () => "{\"version\":1}" }); Object.defineProperty(input, "files", { value: [file] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  await act(async () => container.querySelectorAll("button")[0].click());
  expect(network.mock.calls[0]).toEqual(["/api/internal/sav/intake-evaluation", expect.objectContaining({ method: "POST", body: "{\"version\":1}" })]);
  expect(container.querySelectorAll("button")[0].disabled).toBe(true); expect(container.querySelectorAll("button")[1].disabled).toBe(true);
  await act(async () => container.querySelectorAll("button")[0].click()); expect(network).toHaveBeenCalledOnce();
  await act(async () => finish());
});
