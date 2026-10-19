import { expect, it } from "vitest";
import { normalizeSavConfirmationText } from "./reply-confirmation-text";
import { renderSavOutboundReply } from "./reply-format";
it("canonicalizes only new confirmation line endings and leaves legacy rendering intact", () => {
  const text=" Bonjour,  \r\n\r\nDeux  espaces.\rFin. ";
  expect(normalizeSavConfirmationText(text)).toBe(" Bonjour,  \n\nDeux  espaces.\nFin. ");
  expect(renderSavOutboundReply(text)).toContain("Bonjour,  \r\n\r\nDeux  espaces.\rFin.");
});
