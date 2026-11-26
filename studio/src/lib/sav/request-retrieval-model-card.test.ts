import { afterEach, describe, expect, it, vi } from "vitest";
import { retrieveSavKnowledgeByRequest, savCustomerProcedureSteps, savRetrievalModelCard, SAV_RETRIEVAL_LIMITS, SAV_RETRIEVAL_TRUNCATION_MARKER, type SavRetrievalCandidate } from "./request-retrieval";
import type { CaseSnapshot } from "./cases/case-types";
import { compactCaseKnowledgeContent } from "./cases/investigation-prompt-compact";
import { selectCaseKnowledge } from "./cases/investigation-knowledge";
import { trimCaseScopedKnowledge, type CaseScopedKnowledge } from "./cases/investigation-knowledge-ranking";
import { smartCaseKnowledge } from "./cases/smart/smart-case-provider";
import { smartSourcesOf } from "./cases/smart/smart-knowledge";

// SAV_RETRIEVAL_CARD_SIZE_FIX, review follow-up: what V2 and the smart brain receive. Fictional fiches only.
const now = new Date("2026-10-15T12:00:00Z");
const utf8 = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).length;
const availability = { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" };
const ACADEMY = "Suis le tutoriel Academy « Connecter sa boîte mail » : https://academy.example.invalid/connecter-boite-mail";
const INTERNAL = "Vérifier dans l'outil interne fictif que le jeton du connecteur est expiré.";
const HUMAN = "Réinitialiser le connecteur côté équipe dans la console fictive.";

/** A mailbox-connection procedure like an MCP-published fiche: two customer steps, one internal step, one human-only objective. */
function mailboxFiche(id: string, padding = 0): SavRetrievalCandidate {
  const customer = [
    { id: `${id}.s1`, userLabel: "Déconnecter la boîte", location: "Paramètres > Connexions", instruction: "Clique sur « Déconnecter » à côté de ta boîte mail fictive.", expectedResult: "", prerequisites: [], exceptions: [], escalation: "" },
    { id: `${id}.s2`, userLabel: "Reconnecter la boîte", instruction: ACADEMY, expectedResult: "", prerequisites: [], exceptions: [], escalation: "" },
  ];
  const prerequisites = ["Avoir accès au compte de messagerie fictif."], exceptions = ["Ne pas appliquer à une boîte partagée fictive."];
  const content = ["# Problème de connexion de la boîte mail (fictif)", ...prerequisites, ...customer.map(step => step.instruction), INTERNAL, HUMAN, ...exceptions,
    ...(padding ? ["Annexe fictive. ".repeat(Math.ceil(padding / 16))] : [])].join("\n\n");
  return { id, contentVersionId: `${id}-v1`, title: "Problème de connexion de la boîte mail", content, source: `fixture/${id}`, verifiedAt: "2026-10-14T12:00:00Z", semanticScore: 0.9,
    resolution: { steps: [customer[0]!.instruction, customer[1]!.instruction, INTERNAL, HUMAN], symptoms: ["Pb de connexion boîte mail"], prerequisites, exceptions, escalation: "Transmettre à l'équipe support.",
      troubleshooting: "Transmettre à l'équipe support.", conflictsWith: [], supersedes: [],
      delivery: { version: 1, mode: "procedure", steps: customer, groups: [
        { id: "customer", label: "Reconnecter la boîte mail", requiresHuman: false, prerequisites, exceptions, expectedResult: "", escalation: "", stepIds: customer.map(step => step.id) },
        { id: "team", label: "Réinitialisation par l'équipe", requiresHuman: true, prerequisites: [], exceptions: [], expectedResult: "", escalation: "", stepIds: [] }] } },
    availability };
}
const backend = (batches: SavRetrievalCandidate[][]) => ({ readRevision: vi.fn(async () => "kb-1"), search: vi.fn(async () => batches) });
const on = () => vi.stubEnv("SAV_RETRIEVAL_CARD_SIZE_FIX", "on");
afterEach(() => vi.unstubAllEnvs());

describe("smart brain steps (SAV_RETRIEVAL_CARD_SIZE_FIX)", () => {
  it("the customer steps, label and location included, with the Academy link text; never an internal or human-only step", () => {
    const steps = savCustomerProcedureSteps(mailboxFiche("nylas").resolution)!;
    expect(steps).toEqual([`Déconnecter la boîte — Emplacement : Paramètres > Connexions — Clique sur « Déconnecter » à côté de ta boîte mail fictive.`, `Reconnecter la boîte — ${ACADEMY}`]);
    expect(savCustomerProcedureSteps({ steps: ["Étape fictive"] })).toBeNull();
  });

  it("smartSourcesOf (production search): on, the procedure's customer steps; off, unchanged (none)", async () => {
    const result = await retrieveSavKnowledgeByRequest({ requests: [{ id: "n1", summary: "Pb de connexion boîte mail" }], now }, backend([[mailboxFiche("nylas")]]));
    expect(smartSourcesOf(result)[0]!.steps).toEqual([]);
    on();
    const onResult = await retrieveSavKnowledgeByRequest({ requests: [{ id: "n1", summary: "Pb de connexion boîte mail" }], now }, backend([[mailboxFiche("nylas")]]));
    const [source] = smartSourcesOf(onResult);
    expect(source!.steps.join("\n")).toContain(ACADEMY);
    expect(source!.steps.join("\n")).not.toContain(INTERNAL);
    expect(source!.steps.join("\n")).not.toContain(HUMAN);
  });

  it("smartCaseKnowledge (V2 circuit cards): on, the customer steps; off, the raw steps as before", async () => {
    const fiche = mailboxFiche("nylas");
    const off = await smartCaseKnowledge({ knowledge: [fiche] })([{ id: "need-1" }] as never);
    expect(off.sources[0]!.steps).toEqual(fiche.resolution!.steps);
    on();
    const onSources = await smartCaseKnowledge({ knowledge: [fiche] })([{ id: "need-1" }] as never);
    expect(onSources.sources[0]!.steps).toHaveLength(2);
    expect(onSources.sources[0]!.steps.join("\n")).toContain(ACADEMY);
    expect(onSources.sources[0]!.steps.join("\n")).not.toContain(INTERNAL);
  });

  it("the compact V2 body keeps a procedure's step sections on, deduplicates them off", () => {
    const content = "## Étapes\nOuvrir le panneau fictif.\n\n## Autre\nTexte fictif.";
    const resolution = { steps: ["Ouvrir le panneau fictif."], delivery: { mode: "procedure" } };
    expect(compactCaseKnowledgeContent(content, resolution)).not.toContain("Ouvrir le panneau fictif.");
    on();
    expect(compactCaseKnowledgeContent(content, resolution)).toBe(content);
    expect(compactCaseKnowledgeContent(content, { steps: resolution.steps })).not.toContain("Ouvrir le panneau fictif.");
  });
});

describe("V2 / smart cards are the retrieval's bounded copies (SAV_RETRIEVAL_CARD_SIZE_FIX)", () => {
  const snapshot = { caseId: "case-1", version: 1, body: { openRequests: [{ id: "r1", summary: "Demande relevée.", family: "usage", status: "open", openedAt: "2026-10-15T09:00:00Z",
    subject: { status: "available", text: "Pb de connexion boîte mail fictive", provenance: { source: "v1_accepted_analysis", field: "ticketSummary", runId: "30000000-0000-4000-8000-000000000001",
      runVersion: 1, resultHash: "h", validatorRevision: "v", acceptedAt: "2026-10-15T08:59:00Z" } } }] } } as unknown as CaseSnapshot;
  const scope = { locale: "fr-FR", audience: "support" as const, now };

  it("a raw card read far above the bound (scope read, recall) is shortened with the marker; raw steps kept for the validator", () => {
    on();
    const huge = mailboxFiche("huge", 600_000);
    const card = savRetrievalModelCard(huge);
    expect(utf8({ content: card.content, resolution: card.resolution })).toBeLessThanOrEqual(SAV_RETRIEVAL_LIMITS.contextBytes);
    expect(card.content.endsWith(SAV_RETRIEVAL_TRUNCATION_MARKER)).toBe(true);
    expect(card.resolution!.steps).toEqual(huge.resolution!.steps);
    expect(card.resolution!.delivery).toEqual(huge.resolution!.delivery);
    expect(card.resolution).not.toHaveProperty("prerequisites");
  });

  it("selectCaseKnowledge: off, the backend's raw card object; on, the retrieval's bounded copy of the same card", async () => {
    const huge = mailboxFiche("huge", 600_000);
    const off = await selectCaseKnowledge(snapshot, backend([[huge]]), scope);
    if (off.status !== "ready") throw Error("ready expected");
    expect(off.selection.cards).toEqual([]);
    on();
    const read = await selectCaseKnowledge(snapshot, backend([[huge]]), scope);
    if (read.status !== "ready") throw Error("ready expected");
    expect(read.selection.cards.map(card => card.id)).toEqual(["huge"]);
    const [card] = read.selection.cards;
    expect(utf8(card)).toBeLessThan(SAV_RETRIEVAL_LIMITS.contextBytes);
    expect(card!.content.endsWith(SAV_RETRIEVAL_TRUNCATION_MARKER)).toBe(true);
    expect(card!.resolution!.steps).toEqual(huge.resolution!.steps);
    expect(read.selection.alerts).toContainEqual({ code: "source_truncated", sourceKey: "huge:huge-v1" });
  });

  it("scoped trimming: on, the lowest card's text is halved before the card is dropped; off, it is dropped", () => {
    const big = mailboxFiche("big", 20_000), best = mailboxFiche("best");
    const scoped = { knowledge: [best, big], coverage: [], scopeKeys: new Set<string>(), templateKeys: new Set<string>(), dropped: [], scopeLeftOut: [] } as unknown as CaseScopedKnowledge;
    const fits = (cards: SavRetrievalCandidate[]) => utf8(cards.map(card => card.content)) <= 15_000;
    expect(trimCaseScopedKnowledge(scoped, fits).knowledge.map(card => card.id)).toEqual(["best"]);
    on();
    const trimmed = trimCaseScopedKnowledge(scoped, fits);
    expect(trimmed.knowledge.map(card => card.id)).toEqual(["best", "big"]);
    expect(trimmed.knowledge[1]!.content.endsWith(SAV_RETRIEVAL_TRUNCATION_MARKER)).toBe(true);
    expect(trimmed.dropped).toEqual([]);
  });
});
