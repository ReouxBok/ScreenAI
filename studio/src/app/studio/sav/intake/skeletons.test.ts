import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import StudioLoading from "../../(home)/loading";
import SavLoading from "../loading";
import SavKnowledgeLoading from "../connaissances/loading";
import SavEvaluationLoading from "../evaluation/loading";
import SavResolutionsLoading from "../resolutions/loading";
import SavPilotLoading from "../pilote/loading";
import IntakeConsoleLoading from "./loading";
import IntakeDetailLoading from "./[id]/loading";
import IntakeBudgetLoading from "./budget/loading";
import IntakeLaunchLoading from "./launch/loading";
import IntakeComparisonLoading from "./comparison/loading";
import { savIntakeViewLabels } from "@/lib/sav/intake/contract";

const render = (component: ComponentType) => renderToStaticMarkup(createElement(component));
const all = { StudioLoading, SavLoading, SavKnowledgeLoading, SavEvaluationLoading, SavResolutionsLoading, SavPilotLoading,
  IntakeConsoleLoading, IntakeDetailLoading, IntakeBudgetLoading, IntakeLaunchLoading, IntakeComparisonLoading };

it.each(Object.entries(all))("%s is an announced busy skeleton, never a spinner, a form or a figure", (_name, component) => {
  const html = render(component);
  expect(html).toContain('role="status"');
  expect(html).toContain('aria-busy="true"');
  expect(html).toMatch(/Chargement/);
  expect(html).not.toMatch(/spin|sav-lab-loading/);
  expect(html).not.toMatch(/<(form|button|input|select|textarea)\b/);
  // No count, amount, version or date can appear before the server returns it
  // (the budget's fixed row label "Sur 30 jours glissants" is static wording).
  expect(html.replace(/<[^>]*>/g, " ").replace("Sur 30 jours glissants", "")).not.toMatch(/\d/);
});

it("the intake list skeleton keeps the six view labels without any count or current view", () => {
  const html = render(IntakeConsoleLoading);
  for (const label of Object.values(savIntakeViewLabels)) expect(html).toContain(label);
  expect(html).not.toContain("aria-current");
  expect(html).not.toMatch(/bloqué|Aucun dossier/);
  expect(render(SavLoading)).toBe(html);
});

it("the dossier skeleton claims no HubSpot record, decision or confirmation", () => {
  const html = render(IntakeDetailLoading);
  expect(html).not.toMatch(/Fiche proposée|Ticket proposé|confirmé|Décision actuelle|indisponible/);
});
