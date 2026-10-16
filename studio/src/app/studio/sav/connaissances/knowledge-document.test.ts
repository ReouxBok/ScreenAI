import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { canonicalKnowledgeSchema } from "@/lib/knowledge/contracts";
import { savProjectionBody } from "@/lib/knowledge/conversion";
import { KnowledgeDocument } from "./knowledge-document";

it("makes diagnostic prerequisites, both branches and causal evidence visible during review and comparison", () => {
  const document = canonicalKnowledgeSchema.parse({ schemaVersion: 1, objective: "Diagnostic fictif", applicability: "sav_only", locale: "fr-FR", prerequisites: [], expectedResult: "", escalation: "Revue humaine",
    steps: [{ id: "open", userLabel: "Ouvrir", objective: "Contrôle fictif", instruction: "Ouvrir le panneau fictif.", expectedResult: "Panneau visible", escalation: "Revue humaine" },
      { id: "read", userLabel: "Lire", objective: "Lire le contrôle", instruction: "Lire le résultat fictif.", expectedResult: "Résultat visible", escalation: "Revue humaine" }],
    diagnostic: { requiredFacts: [{ key: "page_url", label: "URL", question: "Quelle URL ?", questionEn: "Which URL?", requiredFor: ["open"] }],
      checks: [{ id: "open", evidenceStepId: "open", instruction: "Ouvrir le panneau fictif.", expectedResult: "Panneau visible", prerequisites: ["page_url"], ifExpected: "read", ifNot: null },
        { id: "read", evidenceStepId: "read", instruction: "Lire le résultat fictif.", expectedResult: "Résultat visible", prerequisites: [], ifExpected: null, ifNot: null }],
      knownCauses: [{ symptom: "Écran fictif vide", cause: "Cause synthétique sourcée", fix: "Correction fictive", evidence: ["read"] }] } });
  const beforeHtml = renderToStaticMarkup(createElement(KnowledgeDocument, { document }));
  const beforeBody = savProjectionBody(document);
  expect(beforeHtml).toContain("Informations préalables : page_url");
  expect(beforeHtml).toContain("Nécessaire avant : Ouvrir (open)");
  expect(beforeHtml).toContain("Si le résultat est obtenu : Lire (read)");
  expect(beforeHtml).toContain("Si le résultat n’est pas obtenu : Arrêter et vérifier avec un humain");
  expect(beforeHtml).toContain("Contrôles de preuve : Lire (read)");
  expect(beforeBody).toContain("Si non obtenu : arrêter et vérifier avec un humain");
  document.diagnostic!.checks[0].ifNot = "read";
  expect(renderToStaticMarkup(createElement(KnowledgeDocument, { document }))).not.toBe(beforeHtml);
  expect(savProjectionBody(document)).not.toBe(beforeBody);
  expect(savProjectionBody(document)).toContain("Si non obtenu : read");
});
