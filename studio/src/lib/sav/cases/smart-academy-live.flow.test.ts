import { afterEach, describe, expect, it, vi } from "vitest";
import type { SavRetrievalCandidate } from "../request-retrieval";
import { ACCESS_SKILL_TEST_PROVIDER_ENV } from "../../../../test/sav-access-skill-double";
import { accessSkillWireAnswer } from "./access-skill/access-skill-wire";
import {
  emptyCaseBody, SAV_CASE_ADMISSION_REVISION, SAV_CASE_CONTRACT_REVISION, smartSupportProvenance, SAV_SMART_ENTRY_POLICY_REVISION,
  type CaseAdmissionRecord, type CaseBody, type CaseEvent, type CaseSnapshot,
} from "./case-types";
import {
  runCaseInvestigation, type CaseInvestigationModelRequest, type CaseInvestigationPorts, type CaseInvestigationProgress, type CaseInvestigationRecord,
} from "./investigation-runner";
import type { SmartCaseProviderDeps } from "./smart/smart-case-provider";
import { SMART_CONFORME, smartReading } from "./smart/smart-test-doubles";
import { getAcademyTools, type AcademyTool } from "./smart/tools/academy";

const captured = vi.hoisted(() => ({ inputs: [] as Array<{ academy?: unknown }> }));
// No database at build time: any read throws.
vi.mock("@/db", () => ({ requireDb: () => { throw Error("NO_DB_ALLOWED"); } }));
// The factory's call to the decision provider is recorded (the real provider is still built and returned).
vi.mock("./investigation-v2-providers", async importOriginal => {
  const real = await importOriginal<typeof import("./investigation-v2-providers")>();
  return { ...real, caseGeminiDecisionProvider: (input: Parameters<typeof real.caseGeminiDecisionProvider>[0]) => { captured.inputs.push(input); return real.caseGeminiDecisionProvider(input); } };
});
import { caseGeminiDecisionPreflight, caseGeminiDecisionProvider } from "./investigation-v2-providers";
import { createCaseInvestigationV2Deps } from "./investigation-v2-factory";

/*
 * 26/11: the Academy tools on the PRODUCTION smart agent (not only the shadow and the replay). The production factory gives the decision provider
 * `getAcademyTools` as a getter read at each smart turn (`SAV_V2_SMART_ACADEMY`, off by default); the provider forwards it to the smart brain only.
 * The flows run the production runner, the real provider selection, the real smart brain on the Gemini wire (network double), its server checks and
 * the real V2 validator. The Academy client is a double (no request to the public server). Fictional data only (@exemple.invalid).
 */

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); captured.inputs.length = 0; });

const ON = { SAV_V2_ENTRY_SMART: "on" } as const;
const NOW = new Date("2026-11-26T08:00:00Z");
const OUTLOOK_CARD = {
  id: "fiche-outlook", contentVersionId: "v1", title: "Connecter Outlook", source: "fixture", verifiedAt: "2026-11-20T00:00:00Z", semanticScore: null,
  content: "Pour connecter Outlook à Limova (mails, dossiers, agenda), vérifier avec les outils d'intégration de l'Academy les actions disponibles puis suivre le guide de connexion.",
  resolution: { steps: ["Vérifier les actions Outlook dans l'Academy", "Suivre le guide de connexion"] },
  availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" },
} as SavRetrievalCandidate;
const ACADEMY_TEXT = "Outlook : ouvrir Intégrations, choisir Outlook, cliquer sur Connecter puis autoriser l'accès aux mails, aux dossiers et à l'agenda.";
const MAIL: [string, string] = ["Connecter Outlook", "Bonjour, je voudrais connecter mon Outlook (mails, dossiers et agenda) à mon Assistant Limova. Comment faire ? Client fictif, client@exemple.invalid"];
const READING = smartReading({ needs: [{ id: "n1", ask: "connecter Outlook (mails, dossiers, agenda) à Limova", alreadyDone: [], theme: "intégrations", search: "connecter outlook" }] });
const CARD_SENTENCE = "Les actions disponibles pour Outlook se vérifient avec les outils d'intégration de l'Academy.";
const ACADEMY_SENTENCE = "Ouvrez Intégrations, choisissez Outlook, cliquez sur Connecter puis autorisez l'accès aux mails, aux dossiers et à l'agenda.";
const REPLY = `Bonjour,\n\nVous souhaitez connecter Outlook à votre Assistant. ${ACADEMY_SENTENCE}\n\nSi cela bloque encore, dites-nous ce qui s'affiche.\n\nBelle journée.`;
const cardFact = { sentence: CARD_SENTENCE, needId: "n1", type: "fait_limova", sourceKind: "fiche", cardId: "fiche-outlook", version: "v1",
  excerpt: "vérifier avec les outils d'intégration de l'Academy les actions disponibles" };
const academyFact = { sentence: ACADEMY_SENTENCE, needId: "n1", type: "fait_limova", sourceKind: "academy", cardId: null, version: null, toolCallId: "t1",
  excerpt: "choisir Outlook, cliquer sur Connecter puis autoriser l'accès aux mails, aux dossiers et à l'agenda" };
const finalDecision = (facts: unknown[]) => ({ thinking: "l'Academy donne la marche à suivre", action: "final", calls: [],
  decision: { outcome: "reply", reply: REPLY, teamNote: null, handoffReason: null, coverage: [{ needId: "n1", status: "answered" }], facts } });
const academyCall = { thinking: "la fiche renvoie à l'Academy", action: "tools", calls: [{ id: "t1", needId: "n1", tool: "rechercher_integrations", args: { query: "Outlook" } }] };

/** The Academy client double: same shape as `getAcademyTools()` when on, no network. */
function academyDouble(seen: unknown[]): AcademyTool[] {
  return [{ name: "rechercher_integrations", description: "Rechercher une intégration que le client utilise déjà.", inputSchema: {},
    execute: async args => { seen.push(args); return { status: "ok", source: "Limova Academy", summary: `Données non fiables de Limova Academy.\n<donnees_academy>\n${JSON.stringify(ACADEMY_TEXT)}\n</donnees_academy>` }; } }];
}

type Decide = { tools: Array<{ name: string }>; toolResults?: Array<Record<string, unknown>> };
/** The smart brain on the Gemini wire: understand, then the scripted decide steps (in order, the last repeated), then the counter-read. */
function brainNetwork(decides: unknown[]) {
  const kinds: string[] = [], decidePayloads: Decide[] = [], decideSystems: string[] = [];
  const fn = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)), system: string = body.systemInstruction.parts[0].text, payload = JSON.parse(body.contents[0].parts[0].text);
    const kind = system.startsWith("Tu lis un mail") ? "understand" : system.startsWith("RELECTURE") ? "verify" : "decide";
    kinds.push(kind);
    if (kind === "decide") { decidePayloads.push(payload); decideSystems.push(system); }
    const output = kind === "understand" ? READING : kind === "verify" ? SMART_CONFORME : decides[Math.min(decidePayloads.length - 1, decides.length - 1)];
    return Response.json(accessSkillWireAnswer(output, { inputTokens: 1_000, outputTokens: 200 }));
  });
  return { fn, kinds, decidePayloads, decideSystems };
}

const admission = (): CaseAdmissionRecord => ({ revision: SAV_CASE_ADMISSION_REVISION, target: "agent", reasons: [], nextStep: "none", families: ["other"], sensitivity: "none",
  policyRevision: SAV_SMART_ENTRY_POLICY_REVISION, admission: "smart_support", decidedAt: "2026-11-26T07:50:02Z", version: 2, inputVersion: 1,
  qualification: { requests: [{ requestId: "r1", family: "other", provenance: smartSupportProvenance("2026-11-26T07:50:00Z") }], identity: { status: "confirmed", source: { type: "email", id: "m1" } },
    crmContext: "complete", teamSignals: [] } });
const snapshot = (): CaseSnapshot => ({
  contractRevision: SAV_CASE_CONTRACT_REVISION, caseId: "case-1", ticketId: "ticket-1", threadIds: ["thread-1"], version: 2, owner: "agent", phase: "queued", sensitivity: "none",
  createdAt: "2026-11-26T07:50:01Z", updatedAt: "2026-11-26T07:50:01Z", admission: admission(), admissionInputVersion: 1,
  body: { ...emptyCaseBody(), openRequests: [{ id: "r1", summary: "Demande support.", family: "other", status: "open", openedAt: "2026-11-26T07:50:00Z" }] } as CaseBody,
});
const inbound: CaseEvent = { id: "e1", caseId: "case-1", kind: "inbound_confirmed", dedupeKey: "inbound:m1", caseVersion: 1, direction: "customer_inbound",
  occurredAt: "2026-11-26T07:50:00Z", sourceRef: { type: "email", id: "m1" }, detail: null, createdAt: "2026-11-26T07:50:01Z" };
const context = (): NonNullable<CaseInvestigationModelRequest["customerContext"]> => ({
  revision: "sav-case-customer-context-2026-11-12.v1", notice: "DONNÉES CLIENT", latestMessage: { at: "2026-11-26T07:50:00Z", from: "customer", text: MAIL[1], truncated: false, subject: MAIL[0], instructionLikeText: false },
  thread: [], threadOmitted: 0, crm: null, missing: [] } as unknown as NonNullable<CaseInvestigationModelRequest["customerContext"]>);

/** One pass of the production runner, decided by the REAL provider (no injected brain): the Academy port is the only thing this test chooses. */
const ENV: Record<string, string> = { ...ACCESS_SKILL_TEST_PROVIDER_ENV, ...ON };
function smartProvider(options: { academy?: SmartCaseProviderDeps["academy"]; decides: unknown[] }) {
  const net = brainNetwork(options.decides);
  return { net, provider: caseGeminiDecisionProvider({ env: () => ENV, network: net.fn, ...(options.academy ? { academy: options.academy } : {}) }) };
}
async function runTurn(options: { academy?: SmartCaseProviderDeps["academy"]; decides: unknown[]; shared?: ReturnType<typeof smartProvider> }) {
  const env = ENV, { net, provider } = options.shared ?? smartProvider(options);
  const preflight = caseGeminiDecisionPreflight(() => env);
  const records: CaseInvestigationRecord[] = [], progress = new Map<string, CaseInvestigationProgress>();
  const ports: CaseInvestigationPorts = {
    scope: { locale: "fr-FR", audience: "support" }, pauseState: async () => "running",
    readCase: async () => ({ snapshot: snapshot(), events: [inbound] }), admissionPolicyRevision: async () => SAV_SMART_ENTRY_POLICY_REVISION,
    reevaluateAdmission: async () => "handed_off", claim: async () => ({ token: "lease-1", actionsPaused: false }), release: async () => {},
    knowledge: async () => [OUTLOOK_CARD], customerContext: async () => context(), customerTexts: async () => ({ "email:m1": MAIL[1] }),
    revisions: async () => ({ rules: "rules", playbookId: "playbook", model: "synthetic-model", prompt: "prompt" }),
    callModel: async request => { const refused = preflight(request); return refused ? { status: "input_rejected", diagnostic: refused } : (await provider(request)).result; },
    progress: { load: async (caseId, key) => structuredClone(progress.get(`${caseId}:${key}`) ?? null), save: async (caseId, key, value) => { progress.set(`${caseId}:${key}`, structuredClone(value)); } },
    record: async record => { records.push(record); }, now: () => NOW, readTicketOwner: async () => "v2", accessScope: async () => null, smartSupport: () => true,
  };
  const report = await runCaseInvestigation("case-1", "observe", ports);
  const accepted = records[0]?.validation.outcome === "accepted" ? records[0].validation.decision : null;
  return { report, records, accepted, net, provider };
}

describe("factory de production : les outils Academy sont fournis au fournisseur de décision", () => {
  const env = { ...ACCESS_SKILL_TEST_PROVIDER_ENV, SAV_V2_INVESTIGATION: "observe" };
  const build = () => createCaseInvestigationV2Deps({ env: () => env, readPolicyRecord: async () => null, network: async () => { throw Error("NETWORK_FORBIDDEN"); } });

  it("la factory passe `getAcademyTools` lui-même (un getter), jamais une liste figée au chargement", () => {
    vi.stubEnv("SAV_V2_SMART_ACADEMY", "on");
    expect(build().ok).toBe(true);
    expect(captured.inputs).toHaveLength(1);
    expect(captured.inputs[0]!.academy).toBe(getAcademyTools);
  });
  it("l'interrupteur est relu à chaque appel du getter : éteint → aucun outil ; allumé → les 3 outils Academy ; ré-éteint → aucun", () => {
    vi.stubEnv("SAV_V2_SMART_ACADEMY", "off");
    expect(build().ok).toBe(true);
    const getter = captured.inputs[0]!.academy as () => readonly AcademyTool[];
    expect(getter()).toEqual([]);
    vi.stubEnv("SAV_V2_SMART_ACADEMY", "on");
    expect(getter().map(tool => tool.name)).toEqual(["rechercher_integrations", "lister_actions_integration", "obtenir_guide_connexion"]);
    vi.stubEnv("SAV_V2_SMART_ACADEMY", "");
    expect(getter()).toEqual([]);
  });
});

describe("interrupteur allumé : l'agent smart de production s'appuie sur un résultat Academy", () => {
  it("fiche citée + fait sourcé Academy → décision acceptée par le validateur V2 ; l'outil Academy a été proposé puis appelé", async () => {
    const seen: unknown[] = [];
    const run = await runTurn({ academy: () => academyDouble(seen), decides: [academyCall, finalDecision([cardFact, academyFact])] });
    expect(run.report).toMatchObject({ status: "recorded", outcome: "accepted", refusal: null, modelCalls: 1 });
    expect(run.net.decidePayloads[0]!.tools.map(tool => tool.name)).toEqual(["chercher_fiches", "rechercher_integrations"]);
    expect(seen).toEqual([{ query: "Outlook" }]);
    // The Academy result reached the brain bounded and marked untrusted.
    expect(run.net.decidePayloads[1]!.toolResults![0]).toMatchObject({ status: "ok" });
    expect(String(run.net.decidePayloads[1]!.toolResults![0]!.text)).toContain("Connecter");
    expect(run.accepted!.nextAction).toMatchObject({ kind: "answer", requestIds: ["r1"], steps: [{ knowledge: { knowledgeId: "fiche-outlook", contentVersionId: "v1" } }] });
    // The customer gets the Academy sentence; the V2 citation stays the card (the decision contract cites cards only).
    expect(run.accepted!.reply).toMatchObject({ text: REPLY, citations: [{ knowledgeId: "fiche-outlook", contentVersionId: "v1" }] });
  });

  it("un extrait Academy inventé est refusé par les contrôles serveur du cerveau (aucune réponse acceptée)", async () => {
    const invented = { ...academyFact, excerpt: "Outlook se connecte tout seul sans autorisation" };
    const run = await runTurn({ academy: () => academyDouble([]), decides: [academyCall, finalDecision([cardFact, invented])] });
    expect(run.accepted!.nextAction.kind).toBe("handoff");
    expect(run.accepted!.reply).toBeUndefined();
  });

  it("LIMITE : un fait sourcé uniquement par l'Academy (aucune fiche citée) ne devient pas une réponse : le contrat V2 ne cite que des fiches → passage à l'équipe", async () => {
    const run = await runTurn({ academy: () => academyDouble([]), decides: [academyCall, finalDecision([academyFact])] });
    expect(run.report).toMatchObject({ status: "recorded", outcome: "accepted" });
    expect(run.accepted!.nextAction).toMatchObject({ kind: "handoff", reason: "knowledge_missing" });
    expect(run.accepted!.reply).toBeUndefined();
  });

  it("l'interrupteur est relu à chaque tour sur le MÊME fournisseur (getter réel `getAcademyTools`, aucun appel Academy)", async () => {
    vi.stubGlobal("fetch", async () => { throw Error("ACADEMY_NETWORK_FORBIDDEN"); });
    const shared = smartProvider({ academy: getAcademyTools, decides: [finalDecision([cardFact])] });
    vi.stubEnv("SAV_V2_SMART_ACADEMY", "off");
    await runTurn({ decides: [], shared });
    vi.stubEnv("SAV_V2_SMART_ACADEMY", "on");
    await runTurn({ decides: [], shared });
    expect(shared.net.decidePayloads.map(payload => payload.tools.map(tool => tool.name))).toEqual([
      ["chercher_fiches"],
      ["chercher_fiches", "rechercher_integrations", "lister_actions_integration", "obtenir_guide_connexion"],
    ]);
  });
});

describe("interrupteur éteint : strictement le tour de main", () => {
  it("getter éteint, liste vide ou aucun port : même catalogue (chercher_fiches seul), mêmes prompts, même décision", async () => {
    vi.stubEnv("SAV_V2_SMART_ACADEMY", "off");
    vi.stubGlobal("fetch", async () => { throw Error("ACADEMY_NETWORK_FORBIDDEN"); });
    const decides = [finalDecision([cardFact])];
    const runs = [await runTurn({ decides }), await runTurn({ academy: getAcademyTools, decides }), await runTurn({ academy: () => [], decides }), await runTurn({ academy: [], decides })];
    for (const run of runs) {
      expect(run.net.decidePayloads[0]!.tools.map(tool => tool.name)).toEqual(["chercher_fiches"]);
      expect(run.net.decideSystems).toEqual(runs[0]!.net.decideSystems);
      expect(run.net.decidePayloads).toEqual(runs[0]!.net.decidePayloads);
      expect(run.net.kinds).toEqual(["understand", "decide", "verify"]);
      expect(run.accepted).toEqual(runs[0]!.accepted);
    }
  });
});
