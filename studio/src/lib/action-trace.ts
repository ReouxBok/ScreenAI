import type { TrainingEventShape } from "./training-events";

export type LearnedActionStep = {
  order: number;
  action: "click" | "input" | "external_popup";
  path: string;
  label: string;
  confidence: "strong" | "medium" | "weak";
  target?: {
    controlType?: string;
    tag?: string;
    role?: string;
    domId?: string;
    testId?: string;
    hrefPath?: string;
    zone?: string;
    section?: string;
    ariaLabel?: string;
    title?: string;
    occurrence?: number;
  };
  preconditions: string[];
  expected: {
    path?: string;
    popup?: "opened_then_closed";
    pageMarkers: string[];
    network: string[];
    fieldFilled?: boolean;
  };
};

type TraceEvent = TrainingEventShape & { id?: string; ordinal?: number };

const stringValue = (value: unknown, max = 240) => typeof value === "string" ? value.trim().slice(0, max) : "";
const numberValue = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;

function unique(values: string[], limit: number) {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].slice(0, limit);
}

function structuralMarkers(context: string) {
  const markers: string[] = [];
  for (const rawLine of context.split("\n")) {
    const line = rawLine.trim();
    if (/^\[(?:modal|form|main)\]$/i.test(line)) markers.push(line);
    else if (/^(?:h[1-3]:|tabs:|⚠|\(empty\))/i.test(line)) markers.push(line.replace(/^\s+/, ""));
  }
  return unique(markers, 6).map(marker => marker.slice(0, 180));
}

function networkMarkers(summary: string) {
  return unique(summary.split("\n")
    .map(line => line.trim())
    .filter(line => /^(?:GET|POST|PUT|PATCH|DELETE|fetch|xmlhttprequest|beacon|script|link|img)\s+/i.test(line))
    .map(line => line.replace(/\s+\d+ms$/i, "").slice(0, 200)), 8);
}

function nearestContextBefore(events: TraceEvent[], index: number) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = events[cursor];
    if (candidate.kind !== "page_context") continue;
    const context = stringValue(candidate.payload.context, 8_000);
    if (context) return context;
  }
  return "";
}

function outcomeAfter(events: TraceEvent[], index: number, gestureId: string) {
  for (let cursor = index + 1; cursor < Math.min(events.length, index + 8); cursor += 1) {
    const candidate = events[cursor];
    if (candidate.kind === "click" || candidate.kind === "input") break;
    if (candidate.kind !== "page_context") continue;
    const phase = stringValue(candidate.payload.phase, 40);
    const candidateGesture = stringValue(candidate.payload.gestureId, 100);
    if (phase === "after_click" && (!gestureId || !candidateGesture || candidateGesture === gestureId)) return candidate;
  }
  return undefined;
}

function nextNavigationPath(events: TraceEvent[], index: number) {
  for (let cursor = index + 1; cursor < Math.min(events.length, index + 8); cursor += 1) {
    const candidate = events[cursor];
    if (candidate.kind === "click" || candidate.kind === "input") break;
    if (candidate.kind === "navigation") return candidate.path;
  }
  return "";
}

function targetFrom(event: TraceEvent): LearnedActionStep["target"] {
  const payload = event.payload;
  const target = {
    controlType: stringValue(payload.controlType, 60) || undefined,
    tag: stringValue(payload.tag, 30) || undefined,
    role: stringValue(payload.role, 50) || undefined,
    domId: stringValue(payload.elementId, 120) || undefined,
    testId: stringValue(payload.testId, 120) || undefined,
    hrefPath: stringValue(payload.hrefPath, 300) || undefined,
    zone: stringValue(payload.zone, 40) || undefined,
    section: stringValue(payload.section, 160) || undefined,
    ariaLabel: stringValue(payload.ariaLabel, 160) || undefined,
    title: stringValue(payload.title, 160) || undefined,
    occurrence: numberValue(payload.occurrence),
  };
  return Object.values(target).some(value => value !== undefined) ? target : undefined;
}

function confidenceFor(target: LearnedActionStep["target"], label: string): LearnedActionStep["confidence"] {
  if (target?.testId || target?.domId) return "strong";
  if (label && (target?.section || target?.hrefPath || target?.ariaLabel)) return "strong";
  if (label && (target?.role || target?.controlType || target?.tag)) return "medium";
  return "weak";
}

export function compileLearnedActionSteps(events: TraceEvent[]): LearnedActionStep[] {
  const steps: LearnedActionStep[] = [];
  let popupOpenIndex = -1;

  events.forEach((event, index) => {
    if (event.kind === "page_context" && /^Fenêtre d’autorisation externe ouverte/.test(event.label)) {
      popupOpenIndex = index;
      return;
    }
    if (event.kind === "page_context" && /^Fenêtre d’autorisation externe fermée/.test(event.label) && popupOpenIndex >= 0) {
      steps.push({
        order: steps.length + 1,
        action: "external_popup",
        path: events[popupOpenIndex].path,
        label: "Autorisation externe",
        confidence: "strong",
        preconditions: structuralMarkers(nearestContextBefore(events, popupOpenIndex)),
        expected: { path: event.path, popup: "opened_then_closed", pageMarkers: [], network: [] },
      });
      popupOpenIndex = -1;
      return;
    }
    if (!['click', 'input'].includes(event.kind)) return;

    const gestureId = stringValue(event.payload.gestureId, 100);
    const outcome = event.kind === "click" ? outcomeAfter(events, index, gestureId) : undefined;
    const outcomeContext = outcome ? stringValue(outcome.payload.context, 8_000) : "";
    const networkSummary = outcome ? stringValue(outcome.payload.networkSummary, 8_000) : "";
    const target = targetFrom(event);
    const label = stringValue(event.label, 240) || "Contrôle observé";
    const expectedPath = outcome?.path || nextNavigationPath(events, index);
    steps.push({
      order: steps.length + 1,
      action: event.kind as "click" | "input",
      path: event.path,
      label,
      confidence: confidenceFor(target, label),
      target,
      preconditions: structuralMarkers(nearestContextBefore(events, index)),
      expected: {
        ...(expectedPath && expectedPath !== event.path ? { path: expectedPath } : {}),
        pageMarkers: structuralMarkers(outcomeContext),
        network: networkMarkers(networkSummary || outcomeContext.match(/\[network\]([\s\S]*)/i)?.[1] || ""),
        ...(event.kind === "input" ? { fieldFilled: true } : {}),
      },
    });
  });

  return steps.slice(0, 50);
}

export function learnedActionsMarkdown(steps: LearnedActionStep[]) {
  if (!steps.length) return "";
  const lines = [
    "## Repères techniques appris",
    "",
    "> Ces repères servent à reconnaître les contrôles dans le DOM actuel. Ils ne sont jamais des sélecteurs à rejouer aveuglément.",
    "",
  ];
  for (const step of steps) {
    const target = step.target;
    const signals = [
      target?.controlType && `type=${target.controlType}`,
      target?.role && `rôle=${target.role}`,
      target?.testId && `test-id=${target.testId}`,
      target?.domId && `id=${target.domId}`,
      target?.section && `zone=${target.section}`,
      target?.hrefPath && `destination=${target.hrefPath}`,
      target?.occurrence && `occurrence=${target.occurrence}`,
    ].filter(Boolean).join(" · ");
    lines.push(`### ${step.order}. ${step.action === "click" ? "Cliquer" : step.action === "input" ? "Renseigner" : "Autorisation externe"} — ${step.label}`);
    lines.push(`- Page apprise : \`${step.path}\``);
    if (signals) lines.push(`- Empreinte de cible : ${signals}`);
    if (step.preconditions.length) lines.push(`- Contexte avant : ${step.preconditions.join(" · ")}`);
    if (step.expected.path) lines.push(`- Page attendue après : \`${step.expected.path}\``);
    if (step.expected.pageMarkers.length) lines.push(`- État attendu : ${step.expected.pageMarkers.join(" · ")}`);
    if (step.expected.network.length) lines.push(`- Effets réseau observés : ${step.expected.network.join(" · ")}`);
    if (step.expected.popup) lines.push("- Résultat attendu : la fenêtre d’autorisation s’ouvre puis se ferme.");
    lines.push("");
  }
  return lines.join("\n").trim();
}
