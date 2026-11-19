import type { SmartKnowledgePort } from "./smart-agent";
import type { SmartSource } from "./smart-checks";
import type { SmartCallKind } from "./smart-contract";
import type { SmartCallResult, SmartModelPort } from "./smart-model";

/*
 * Agent SAV intelligent (20/11): the scripted model and knowledge of the tests. No network, no key, no money; FICTIONAL data only.
 * A script answers per call kind (`understand`, `decide`, `verify`, `correct`, `reverify`): a model output, a failure, or the deadline.
 */

export type SmartScriptAnswer = Readonly<{ output: unknown }> | Readonly<{ fail: string; sent?: boolean; uncertain?: boolean }> | Readonly<{ deadline: true }>;
export type SmartScript = Partial<Record<Exclude<SmartCallKind, "embed">, SmartScriptAnswer | ((payload: unknown) => SmartScriptAnswer) | SmartScriptAnswer[]>>;

export function smartScriptedModel(script: SmartScript) {
  const calls: Array<{ kind: string; payload: unknown; system: string }> = [];
  const model: SmartModelPort = async ({ kind, payload, system }) => {
    calls.push({ kind, payload, system });
    // An array answers successive calls of the same kind (the decide passes), the last one repeated.
    const count = calls.filter(row => row.kind === kind).length;
    const raw = script[kind], entry = Array.isArray(raw) ? raw[Math.min(count - 1, raw.length - 1)] : raw, answer = typeof entry === "function" ? entry(payload) : entry;
    const inputBytes = Buffer.byteLength(JSON.stringify(payload));
    if (!answer) return { status: "failed", problem: "unscripted", uncertain: false, usage: null, inputBytes, sent: false } satisfies SmartCallResult;
    if ("deadline" in answer) return { status: "failed", problem: "deadline", uncertain: false, usage: null, inputBytes, sent: false };
    if ("fail" in answer) return { status: "failed", problem: answer.fail, uncertain: answer.uncertain ?? false, usage: null, inputBytes, sent: answer.sent ?? true };
    // A bare decision scripted for « decide » is wrapped as a final step (v2), so the v1 scenarios read the same.
    const output = kind === "decide" && answer.output && typeof answer.output === "object" && !("action" in answer.output) ? { thinking: "", action: "final", calls: [], decision: answer.output } : answer.output;
    return { status: "ok", output, usage: { inputTokens: 1_000, outputTokens: 200 }, inputBytes };
  };
  return { model, calls };
}

export const SMART_TEST_CARD: SmartSource = {
  cardId: "fiche-connexion", version: "v3", title: "Se connecter à Limova",
  content: "Pour vous connecter, utilisez l'adresse e-mail de votre invitation. Si le code n'arrive pas, vérifiez le dossier des indésirables.",
  steps: ["Ouvrir la page de connexion", "Saisir l'adresse e-mail de l'invitation"], needIds: ["n1"], validUntil: null,
};
export function smartStaticKnowledge(sources: readonly SmartSource[] = [SMART_TEST_CARD]): SmartKnowledgePort & { calls: number } {
  const port = Object.assign(async () => { port.calls += 1; return { status: "ok" as const, sources, codes: [] }; }, { calls: 0 });
  return port;
}

export const smartReading = (extra: Record<string, unknown> = {}) => ({
  needs: [{ id: "n1", ask: "se connecter à son espace", alreadyDone: ["a demandé un nouveau code"], theme: "connexion", search: "connexion code non reçu" }],
  sensitive: "no", sensitiveFamilies: [], wantsHuman: false, upset: false, instructionInMail: false, ...extra,
});
export const SMART_GOOD_REPLY = "Bonjour,\n\nVous n'arrivez pas à vous connecter. Utilisez l'adresse e-mail de votre invitation. Si le code n'arrive pas, regardez dans le dossier des indésirables.\n\nSi cela bloque encore, dites-nous quel message s'affiche.\n\nBelle journée.";
export const smartGoodDecision = (extra: Record<string, unknown> = {}) => ({
  outcome: "reply", reply: SMART_GOOD_REPLY, teamNote: null, handoffReason: null, coverage: [{ needId: "n1", status: "answered" }],
  facts: [{ sentence: "Utilisez l'adresse e-mail de votre invitation.", needId: "n1", type: "fait_limova", sourceKind: "fiche", cardId: "fiche-connexion", version: "v3",
    excerpt: "utilisez l'adresse e-mail de votre invitation" }],
  ...extra,
});
export const SMART_CONFORME = { verdict: "conforme", problems: [] };
