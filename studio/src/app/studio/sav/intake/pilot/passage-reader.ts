import { createHash } from "node:crypto";
import { z } from "zod";
export type PassageCase = { ref: string; label: string; responsible: string; reason: string; ownerReading: string;
  flow: { label: string; text: string; basis: string }[]; sources: { id: string; version: string; title: string; content: string; verifiedAt: string; verification: "fresh" | "revalidation_due"; evaluatedAt: string }[];
  draft: string | null; scope: string | null; counters: { modelCalls: number; posts: number; ownerWrites: number; mailsSent: 0 } };
export type Passage = { provenance: string; producerSha: string; artifactHash: string; evidence: string; scenarios: PassageCase[] };
export type PassageRead = { ok: true; data: Passage } | { ok: false; reason: string };
const text = z.string().min(1).max(4000), ref = z.string().min(1).max(160);
const counter = z.number().int().nonnegative().max(100);
const source = z.object({ knowledgeId: ref, contentVersionId: ref, permission: z.literal("answer"), title: text, content: text, verifiedAt: z.string().datetime({ offset: true }), verification: z.enum(["fresh", "revalidation_due"]), evaluatedAt: z.string().datetime({ offset: true }) }).strict().refine(s => Date.parse(s.verifiedAt) <= Date.parse(s.evaluatedAt), "Source verification cannot be in the future at evaluation");
const passage = z.object({ state: z.enum(["agent_ready", "team_person", "team_out_of_scope"]), situation: ref,
  v2Work: z.boolean(), ownerWrite: z.literal(false), atomicOwnerCompare: z.literal("not_proven"),
  caseOwner: z.enum(["agent", "human"]), crmReading: z.enum(["v2", "human", "none", "unknown", "read_failed", "not_read"]),
  admission: z.object({ target: z.enum(["agent", "team"]), reasons: z.array(ref).max(30) }).strict() }).strict();
const scenario = z.object({ ref: z.enum(["SYN-P1", "SYN-P2", "SYN-P3"]), label: text, passage,
  decision: z.object({ status: z.literal("accepted"), contract: ref, decidedOn: z.number().finite(), scope: z.object({ revision: ref, policyRevision: ref }).strict() }).strict().nullable(),
  sourcesStatus: z.enum(["proven_from_decision", "no_search_case_with_team"]), sources: z.array(source).max(20),
  draft: z.object({ status: z.literal("awaiting_validation"), validatable: z.literal(true), purpose: z.literal("answer"), subject: text, text }).strict().nullable(),
  counters: z.object({ modelCalls: counter, ticketPosts: counter, ownerWrites: z.literal(0), mailsSent: z.literal(0) }).strict(),
  refusedDraftCode: ref.optional() }).strict();
const artifact = z.object({ schema: z.literal("sav-pilot-passage.syn.v1"), simulated: z.literal(true), atomicOwnerCompare: z.literal("not_proven"), ids: z.literal("invented"), sourcesAndScope: z.literal("invented_fixture_no_real_sheet_approved_by_nobody"), model: z.literal("synthetic_port_no_paid_call"), rows: z.array(z.unknown()).length(6) }).strict();
const metadata = z.object({ producerSha: z.string().regex(/^[a-f0-9]{40}$/), artifactHash: z.string().regex(/^[a-f0-9]{64}$/), evidence: text, authorTested: z.literal(true) }).strict();
const readings = { v2: "SAV Pilote", human: "Une personne", none: "Sans propriétaire", unknown: "Propriétaire inconnu", read_failed: "Lecture en échec", not_read: "Non lu" };
/** A display may not upgrade absent source/scope proof into a validatable answer. Whole artifact fails closed. */
export function decodePassageArtifact(raw: string, provenance: unknown): PassageRead {
  try {
    if (raw.length > 128_000) throw Error();
    const meta = metadata.parse(provenance);
    if (createHash("sha256").update(raw).digest("hex") !== meta.artifactHash) throw Error();
    const data = artifact.parse(JSON.parse(raw));
    if (data.rows.map(r => (r as { ref?: unknown })?.ref).join(",") !== "SYN-P1,SYN-P2,SYN-P3,SYN-R2,SYN-R3,SYN-R4") throw Error();
    const rows = data.rows.slice(0, 3).map(r => scenario.parse(r));
    const [agent, human, mixed] = rows;
    if (agent.passage.state !== "agent_ready" || !agent.passage.v2Work || agent.passage.caseOwner !== "agent" || agent.passage.crmReading !== "v2" || agent.passage.admission.target !== "agent"
      || !agent.decision || !agent.draft || !/\bIA\b/.test(agent.draft.text) || agent.sourcesStatus !== "proven_from_decision" || !agent.sources.length || !agent.counters.modelCalls) throw Error();
    if (new Set(agent.sources.map(s => `${s.knowledgeId}/${s.contentVersionId}`)).size !== agent.sources.length) throw Error();
    if (human.passage.state !== "team_person" || human.passage.crmReading !== "human" || mixed.passage.state !== "team_out_of_scope" || mixed.passage.admission.target !== "team") throw Error();
    for (const row of [human, mixed]) if (row.passage.v2Work || row.passage.caseOwner !== "human" || row.decision || row.draft || row.sources.length || row.sourcesStatus !== "no_search_case_with_team" || row.counters.modelCalls) throw Error();
    return { ok: true, data: { producerSha: meta.producerSha, artifactHash: meta.artifactHash, evidence: meta.evidence,
      provenance: "Lecture de l’export de trois scénarios exécutés par C sur les contrats locaux V1, admission V2, investigation et préparation. L’écran ne relance pas ces opérations.",
      scenarios: rows.map(row => {
        const isAgent = row.ref === "SYN-P1", isHuman = row.ref === "SYN-P2";
        const reason = isAgent ? "Le propriétaire SAV Pilote a été relu. La décision et les sources de la réponse sont prouvées dans cette simulation." : isHuman ? "Le ticket appartient à une personne. L’agent ne commence aucune investigation." : "La demande mêle connexion et facturation. Elle reste à l’équipe avant investigation.";
        return { ref: row.ref, label: row.label, responsible: isAgent ? "SAV Pilote · réponse à valider" : "Équipe", reason, ownerReading: readings[row.passage.crmReading],
          flow: [{ label: "Intake V1", text: isHuman ? "Le mail est rattaché au ticket existant." : isAgent ? "Création du ticket avec le propriétaire SAV Pilote dans le transport CRM synthétique." : "Création du ticket sans attribution au pilote.", basis: "Contrats V1 exécutés localement · transport SYN" },
            { label: "Admission V2", text: row.passage.admission.target === "agent" ? "Demande admise selon la politique injectée ; la propriété du ticket reste contrôlée séparément." : "Demande conservée par l’équipe selon la politique injectée.", basis: "Contrat d’admission exécuté localement · politique SYN" },
            { label: "Investigation et réponse", text: isAgent ? "Réponse enregistrée avec sa mention IA, en attente de validation humaine." : "Aucune investigation ni réponse de l’agent.", basis: isAgent ? "Moteur local · connaissance et modèle SYN" : "Refus du moteur local avant le modèle" }],
          sources: row.sources.map(s => ({ id: s.knowledgeId, version: s.contentVersionId, title: s.title, content: s.content, verifiedAt: s.verifiedAt, verification: s.verification, evaluatedAt: s.evaluatedAt })),
          draft: row.draft?.text ?? null, scope: row.decision ? `${row.decision.scope.revision} · politique ${row.decision.scope.policyRevision}` : null,
          counters: { modelCalls: row.counters.modelCalls, posts: row.counters.ticketPosts, ownerWrites: row.counters.ownerWrites, mailsSent: row.counters.mailsSent } };
      }) } };
  } catch { return { ok: false, reason: "L’export SYN ne prouve pas les trois parcours, leurs sources et le périmètre de la réponse, ou son empreinte a changé." }; }
}
