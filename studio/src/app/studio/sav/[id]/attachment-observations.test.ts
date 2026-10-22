import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { AttachmentObservations } from "./attachment-observations";
import { attachmentMetadata, observedAttachment } from "../../../../../test/sav-attachments";
afterEach(() => vi.unstubAllGlobals());
it("renders acquired observations and explicit limitations without any request or image tag", () => {
  const network = vi.fn(() => { throw new Error("UNEXPECTED_NETWORK"); }); vi.stubGlobal("fetch", network);
  const read = observedAttachment(); read.observations[0].text = 'Erreur E42 <script>alert("fixture")</script>';
  const markup = renderToStaticMarkup(createElement(AttachmentObservations, { attachments: [attachmentMetadata()], read }));
  expect(markup).toContain("Analysée"); expect(markup).toContain("Erreur E42"); expect(markup).toContain("&lt;script&gt;");
  expect(markup).not.toContain("<script>"); expect(markup).not.toContain("<img"); expect(network).not.toHaveBeenCalled();
});
it("shows legacy metadata as unread, without claiming an analysis", () => {
  const markup = renderToStaticMarkup(createElement(AttachmentObservations, { attachments: [attachmentMetadata()] }));
  expect(markup).toContain("Non lue"); expect(markup).toContain("Aucune observation visuelle acquise");
});

it("warns about an incomplete inventory without pretending omitted files were analyzed", () => {
  const markup = renderToStaticMarkup(createElement(AttachmentObservations, { attachments: [attachmentMetadata()], inventory: { complete: false, limits: ["reference_limit"] } }));
  expect(markup).toContain("Au moins 1 pièce(s) jointe(s)");
  expect(markup).toContain("Inventaire incomplet");
  expect(markup).toContain("Non lue");
  expect(markup).toContain("Leur nombre et leur contenu ne sont pas connus");
});
it("shows the incomplete inventory even when no reference was found before the traversal limit", () => {
  const markup = renderToStaticMarkup(createElement(AttachmentObservations, { attachments: [], inventory: { complete: false, limits: ["depth_limit"] } }));
  expect(markup).toContain("Inventaire des pièces jointes incomplet");
  expect(markup).not.toContain("0 pièce(s)");
});
