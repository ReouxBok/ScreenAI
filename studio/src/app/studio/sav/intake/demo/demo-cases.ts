import pilotEvidenceArtifact from "./fixtures/pilot-access-evidence.v1.json";
import { readPilotEvidence, type PilotBasis, type PilotEvidenceCase, type PilotOwner } from "./pilot-access-evidence";

// UX 3 November: SYN demonstration of the V2 cases inside the real Studio (Agent SAV > Demandes), local only: the three John cases
// and the access pilot, read from a SYN versioned evidence artifact (pilot-access-evidence.ts): pole A's tested hand-over at an exact head,
// pole C unverified. The dedicated owner « SAV Pilote » is fictitious; its private ownerId is not confirmed and never written here.
// Provisional read model written by UX: pole C's read model of the three cases and pole A's admission contract are not
// delivered on b6c0db, so nothing here is read from a store, HubSpot, Gmail or a model. Every line says it is a demonstration;
// no case has a real follow-up and no command exists. Counters and details read the same objects below.

export const DEMO_SCHEMA = "sav-v2-demo-console.v1";
export const DEMO_LIST_PATH = "/studio/sav/intake/demo";
export const DEMO_LIST_MEMORY = "sav:intake:demo-list:v1";

/** Never reachable in a production build: the pages answer 404 before any staff check or read. */
export const demoConsoleEnabled = () => process.env.NODE_ENV !== "production";

export type DemoSet = "john" | "acces";
export const demoSetLabels: Readonly<Record<DemoSet, string>> = { john: "Ancien cas John", acces: "Pilote accès" };
export const DEMO_SETS = Object.keys(demoSetLabels) as DemoSet[];

/** The pilot's dedicated owner as the demonstration injects it: a label only. No ownerId (private, not confirmed), never the API identity
 * nor the author shown on actions. */
export const PILOT_OWNER_FIXTURE = Object.freeze({ name: "SAV Pilote", ownerId: null, confirmed: false, source: "fixture injectée par la démonstration" });

export type DemoOwner = "agent_v2" | PilotOwner;
export const demoOwnerLabels: Readonly<Record<DemoOwner, string>> = {
  agent_v2: "Agent V2, sous supervision",
  sav_pilote: `Agent : ${PILOT_OWNER_FIXTURE.name} confirmé`,
  human: "Équipe : propriétaire humain du ticket",
  team_sensitive: "Équipe : hors autonomie",
  owner_empty: "Équipe : sans propriétaire, non acquis",
  owner_unknown: "Non lu : propriétaire inconnu",
  team_rule: "Équipe : ticket existant ou pause",
};
export const DEMO_OWNERS = Object.keys(demoOwnerLabels) as DemoOwner[];

export const demoBasisLabels: Readonly<Record<PilotBasis, string>> = {
  reel: "Production aujourd’hui",
  a_teste: "Testé localement par A (SYN)",
  fixture: "Donnée fictive injectée",
  non_verifie: "Résultat non vérifié",
};
export type DemoPilot = PilotEvidenceCase;

export type DemoCase = Readonly<{
  ref: "demo-1" | "demo-2" | "demo-3" | PilotEvidenceCase["ref"];
  set: DemoSet;
  title: string; subject: string; from: string; receivedAt: string; ticket: string;
  owner: DemoOwner; ownerWhy: string; state: string; tone: "accent" | "warning" | "danger";
  message: string; proofs: readonly string[]; next: string;
  /** What the V2 agent did on this case, as the demonstration declares it (no counter is measured). Absent for the pilot: see pilot.downstream. */
  machine?: Readonly<{ admitted: boolean; knowledgeReads: number; generations: number; sends: 0 }>;
  rules: readonly string[];
  pilot?: DemoPilot;
}>;

const MAIL = "Bonjour, je n’arrive pas à importer ma vidéo dans John : le chargement s’arrête à la fin. Comment faire ? Merci.";

/** The pilot as read from the artifact; an invalid artifact gives no pilot case at all (the page says why). */
export const PILOT_EVIDENCE = readPilotEvidence(pilotEvidenceArtifact);
export const DEMO_CASES: readonly DemoCase[] = [
  {
    ref: "demo-1", set: "john", title: "Cas 1 · Import vidéo John, ticket sans propriétaire", subject: "Import d’une vidéo dans John", from: "client.fictif@example.test",
    receivedAt: "2026-11-03T08:00:00.000Z", ticket: "Ticket fictif SYN-T-1001, sans propriétaire",
    owner: "agent_v2", ownerWhy: "Ticket sans propriétaire et demande d’utilisation : le dossier est admis en V2.",
    state: "Réponse proposée, en attente de validation humaine", tone: "accent", message: MAIL,
    proofs: [
      "Mail fictif rattaché au ticket SYN-T-1001 (relais V1 simulé).",
      "Propriétaire du ticket : aucun (lecture simulée, pas HubSpot).",
      "Admission : demande d’utilisation, aucune catégorie sensible.",
      "Une fiche de connaissance de démonstration consultée, version figée (contenu non audité).",
      "Proposition avec mention IA, empreinte calculée avant la validation.",
    ],
    next: "Une personne relit et valide la proposition. La démonstration n’envoie rien.",
    machine: { admitted: true, knowledgeReads: 1, generations: 1, sends: 0 },
    rules: ["Si l’équipe reprend le ticket ou si un nouveau mail arrive, cette proposition n’est plus valable : elle n’est jamais envoyée telle quelle."],
  },
  {
    ref: "demo-2", set: "john", title: "Cas 2 · Même mail, ticket humain", subject: "Import d’une vidéo dans John", from: "client.fictif@example.test",
    receivedAt: "2026-11-03T08:05:00.000Z", ticket: "Ticket fictif SYN-T-1002, propriétaire humain",
    owner: "human", ownerWhy: "Le ticket a un propriétaire humain : il est exclu entièrement de la V2.",
    state: "Aucun traitement V2", tone: "warning", message: MAIL,
    proofs: [
      "Même mail fictif que le cas 1.",
      "Propriétaire du ticket : une personne de l’équipe (lecture simulée, pas HubSpot).",
      "Admission : refusée, ticket humain.",
    ],
    next: "L’équipe garde la main dans HubSpot. L’agent V2 ne prépare, n’écrit et n’envoie rien.",
    machine: { admitted: false, knowledgeReads: 0, generations: 0, sends: 0 },
    rules: ["Une lecture du propriétaire en échec ou inconnue n’est jamais traitée comme « sans propriétaire »."],
  },
  {
    ref: "demo-3", set: "john", title: "Cas 3 · Incident et facturation", subject: "Appels coupés et facture du mois en double", from: "client.fictif@example.test",
    receivedAt: "2026-11-03T08:10:00.000Z", ticket: "Ticket fictif SYN-T-1003",
    owner: "team_sensitive", ownerWhy: "Une demande de facturation dans le même mail : tout le dossier sort de l’autonomie.",
    state: "Hors autonomie avant investigation", tone: "danger",
    message: "Bonjour, mes appels sont coupés depuis hier et j’ai été facturé deux fois ce mois-ci. Pouvez-vous regarder ? Merci.",
    proofs: [
      "Deux demandes dans le même mail : incident technique et facturation.",
      "La facturation prime sur tout le dossier, y compris l’incident.",
      "Arrêt avant l’investigation.",
    ],
    next: "L’équipe traite le dossier entier. Ticket interne possible, sans réponse IA ni apprentissage.",
    machine: { admitted: false, knowledgeReads: 0, generations: 0, sends: 0 },
    rules: ["Une simple question d’utilisation sur les crédits reste une question d’utilisation ; un remboursement, une facture ou une résiliation demandés font primer la catégorie sensible."],
  },
  ...pilotCases(),
];

function pilotCases(): DemoCase[] {
  if (!PILOT_EVIDENCE.ok) return [];
  return PILOT_EVIDENCE.evidence.cases.map((c, i): DemoCase => ({
    ref: c.ref, set: "acces", title: c.title, subject: c.subject, from: "client.fictif@example.test",
    receivedAt: new Date(Date.UTC(2026, 10, 3, 9, 5 * i)).toISOString(), ticket: c.ticket,
    owner: c.owner, ownerWhy: c.cause ?? `Ticket créé par V1 avec ${PILOT_OWNER_FIXTURE.name} et relu ainsi : testé localement par A, jamais en production aujourd’hui.`,
    state: c.hand === "agent" ? "Raccord testé : l’agent a la main ; suite de C non vérifiée" : c.hand === "unread" ? "Propriétaire non lu : aucun dossier créé" : "L’équipe garde le dossier",
    tone: c.hand === "agent" ? "accent" : c.owner === "team_sensitive" ? "danger" : "warning", message: c.message,
    // Operator wording: the steps pole A's tests cover, in French; the raw test titles stay in the detail's technical references.
    proofs: c.flow.filter(f => f.basis === "a_teste").map(f => `Testé localement par A · ${f.step} : ${f.value}`), next: c.next,
    rules: c.hand === "agent" ? [
      `Propriétaire absent ne veut pas dire acquis : seul un ticket créé par V1 avec ${PILOT_OWNER_FIXTURE.name}, et relu ainsi, donne la main à l’agent.`,
      "La prise n’est jamais garantie : une personne qui reprend le ticket le garde, un nouveau mail ne le rend pas à l’agent.",
      "Une réponse préparée n’est pas une réponse envoyée.",
    ] : [],
    pilot: c,
  }));
}

export const findDemoCase = (ref: unknown) => typeof ref === "string" ? DEMO_CASES.find(c => c.ref === ref) ?? null : null;

export type DemoFilter = Readonly<{ set: DemoSet | null; owner: DemoOwner | null; q: string }>;
/** Unknown filter values are refused, never dropped silently. */
export function readDemoFilter(raw: { set?: string; owner?: string; q?: string }): DemoFilter | null {
  const set = raw.set || null, owner = raw.owner || null, q = (raw.q ?? "").trim();
  if (set !== null && !(DEMO_SETS as string[]).includes(set)) return null;
  if (owner !== null && !(DEMO_OWNERS as string[]).includes(owner)) return null;
  if (q.length > 120) return null;
  return { set: set as DemoSet | null, owner: owner as DemoOwner | null, q };
}
const matches = (c: DemoCase, q: string) => !q || `${c.subject} ${c.title}`.toLocaleLowerCase("fr").includes(q.toLocaleLowerCase("fr"));
export const demoRows = (filter: DemoFilter) => DEMO_CASES.filter(c => (!filter.set || c.set === filter.set) && (!filter.owner || c.owner === filter.owner) && matches(c, filter.q));
/** Counters per owner over the same objects as the rows and the details, under the current journey and search. */
export function demoCounts(q: string, set: DemoSet | null = null) {
  const all = DEMO_CASES.filter(c => (!set || c.set === set) && matches(c, q));
  return { all: all.length, ...Object.fromEntries(DEMO_OWNERS.map(o => [o, all.filter(c => c.owner === o).length])) } as Record<"all" | DemoOwner, number>;
}
/** Counters per journey under the current search, whatever the owner tab. */
export function demoSetCounts(q: string) {
  const all = DEMO_CASES.filter(c => matches(c, q));
  return { all: all.length, ...Object.fromEntries(DEMO_SETS.map(s => [s, all.filter(c => c.set === s).length])) } as Record<"all" | DemoSet, number>;
}

export const demoListHref = (filter: DemoFilter) => {
  const params = new URLSearchParams();
  if (filter.set) params.set("set", filter.set);
  if (filter.owner) params.set("owner", filter.owner);
  if (filter.q) params.set("q", filter.q);
  return params.size ? `${DEMO_LIST_PATH}?${params}` : DEMO_LIST_PATH;
};
/** The list a detail may go back to: only the demo list with a known filter, and a known case anchor. Anything else is refused. */
export function demoListDestination(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 600 || !value.startsWith("/") || /[\\\u0000-\u001f]/.test(value)) return null;
  let url: URL;
  try { url = new URL(value, "https://studio.invalid"); } catch { return null; }
  if (url.origin !== "https://studio.invalid" || url.pathname !== DEMO_LIST_PATH) return null;
  const keys = [...url.searchParams.keys()];
  if (keys.some(k => k !== "set" && k !== "owner" && k !== "q") || new Set(keys).size !== keys.length) return null;
  const filter = readDemoFilter({ set: url.searchParams.get("set") ?? undefined, owner: url.searchParams.get("owner") ?? undefined, q: url.searchParams.get("q") ?? undefined });
  if (!filter) return null;
  if (url.hash && !findDemoCase(url.hash.slice(1))) return null;
  return `${demoListHref(filter)}${url.hash}`;
}
export const demoCaseHref = (ref: DemoCase["ref"], origin: string) =>
  `${DEMO_LIST_PATH}/${ref}?${new URLSearchParams({ returnTo: `${(demoListDestination(origin) ?? DEMO_LIST_PATH).split("#")[0]}#${ref}` })}`;

export type DemoListMemory = { href: string; y: number; focusId: string };
export function parseDemoListMemory(value: unknown): DemoListMemory | null {
  if (typeof value !== "string" || value.length > 1000) return null;
  try {
    const row = JSON.parse(value), href = demoListDestination(row.href);
    return href && Number.isFinite(row.y) && row.y >= 0 && row.y <= 2_000_000 && findDemoCase(row.focusId) ? { href, y: row.y, focusId: row.focusId } : null;
  } catch { return null; }
}
