export type TrainingEventShape = {
  kind: string;
  path: string;
  label: string;
  payload: Record<string, string | number | boolean | null>;
};

function normalized(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr").replace(/\s+/g, " ").trim();
}

export function compactTrainingEvents<T extends TrainingEventShape>(events: T[]): T[] {
  const kept: T[] = [];
  const seen = new Set<string>();

  for (const event of events) {
    let key = "";
    if (event.kind === "voice_note") {
      kept.push(event);
      continue;
    }
    if (event.kind === "click") key = `click:${normalized(event.label)}`;
    else if (event.kind === "input") key = `input:${normalized(event.label)}`;
    else if (event.kind === "navigation") key = `navigation:${event.path}`;
    else if (event.kind === "page_context" && /^Fenêtre d’autorisation externe ouverte/.test(event.label)) key = "external-popup:opened";
    else if (event.kind === "page_context" && /^Fenêtre d’autorisation externe fermée/.test(event.label)) {
      key = "external-popup:closed";
      const previous = kept.findIndex(item => item.kind === "page_context" && /^Fenêtre d’autorisation externe fermée/.test(item.label));
      if (previous >= 0) kept.splice(previous, 1);
      kept.push(event);
      seen.add(key);
      continue;
    } else if (event.kind === "page_context" && /^Popup Limova/.test(event.label)) key = `modal:${normalized(event.label)}`;
    else if (event.kind === "page_context" && event.payload.phase === "after_click") key = `outcome:${String(event.payload.gestureId || normalized(event.label))}`;
    else continue;

    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(event);
  }
  return kept;
}
