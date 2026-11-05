// UX 3 November (suite): reader of the access pilot's evidence artifact (fixtures/pilot-access-evidence.v1.json). The artifact is SYN,
// deterministic and versioned; it cites pole A's local tests at an exact head and states pole C as unverified until C is qualified. The page
// shows nothing of the pilot unless the whole artifact validates: unknown values, a C result claimed without a head, a hand inconsistent with
// the owner reading or anything that looks like an owner identifier reject it (fail closed). No network, no store, no env.

export const PILOT_EVIDENCE_SCHEMA = "sav-v2-pilot-access-evidence";
export const PILOT_EVIDENCE_REVISION = 1;

export const PILOT_READINGS = ["confirmed", "empty", "other_person", "unknown", "not_read"] as const;
export type PilotReading = typeof PILOT_READINGS[number];
export const pilotReadingLabels: Readonly<Record<PilotReading, string>> = {
  confirmed: "SAV Pilote confirmé",
  empty: "Sans propriétaire (vide)",
  other_person: "Autre personne",
  unknown: "Inconnu (non lisible)",
  not_read: "Non lu",
};
export const PILOT_HANDS = ["agent", "team", "unread"] as const;
export type PilotHand = typeof PILOT_HANDS[number];
export const pilotHandLabels: Readonly<Record<PilotHand, string>> = { agent: "Agent", team: "Équipe", unread: "Non lu : personne n’est désigné" };
export const PILOT_BASES = ["reel", "a_teste", "fixture", "non_verifie"] as const;
export type PilotBasis = typeof PILOT_BASES[number];
export const PILOT_OWNERS = ["sav_pilote", "human", "team_sensitive", "owner_empty", "owner_unknown", "team_rule"] as const;
export type PilotOwner = typeof PILOT_OWNERS[number];

export type PilotEvidenceCase = Readonly<{
  ref: `acces-${1 | 2 | 3 | 4 | 5 | 6 | 7}`;
  title: string; subject: string; message: string; ticket: string;
  reading: PilotReading; hand: PilotHand; owner: PilotOwner; cause: string | null; situation: string; today: string;
  flow: readonly Readonly<{ step: string; value: string; basis: PilotBasis }>[];
  identities: Readonly<{ api: string; ticketOwner: string; author: string }>;
  next: string;
  evidence: readonly Readonly<{ pole: "A"; test: string }>[];
  downstream: Readonly<{ status: "unverified" | "not_applicable"; text: string }>;
}>;
export type PilotEvidenceSource = Readonly<{ status: "author_tested" | "unverified"; head: string | null; result: string; testFile?: string }>;
export type PilotEvidence = Readonly<{ schema: string; revision: number; synthetic: true; sources: Readonly<{ A: PilotEvidenceSource; C: PilotEvidenceSource }>; cases: readonly PilotEvidenceCase[] }>;
export type PilotEvidenceRead = { ok: true; evidence: PilotEvidence } | { ok: false; reason: string };

const REFS = ["acces-1", "acces-2", "acces-3", "acces-4", "acces-5", "acces-6", "acces-7"];
const HEAD = /^[0-9a-f]{40}$/;
const text = (v: unknown, max = 400): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[<>\u0000-\u001f]/.test(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);
const keys = (v: unknown, expected: string[]) => typeof v === "object" && v !== null && !Array.isArray(v)
  && Object.keys(v).length === expected.length && expected.every(k => Object.hasOwn(v, k));

function source(v: unknown, pole: "A" | "C"): string | null {
  const s = v as Record<string, unknown>;
  if (!keys(v, pole === "A" ? ["status", "head", "testFile", "result"] : ["status", "head", "result"])) return `source ${pole}: champs inattendus`;
  if (!oneOf(["author_tested", "unverified"], s.status) || !text(s.result)) return `source ${pole}: statut ou résultat illisible`;
  // A result is "tested" only with an exact head; an unverified source carries no head, so nothing can pass for a qualified C.
  if (s.status === "author_tested" ? typeof s.head !== "string" || !HEAD.test(s.head) : s.head !== null) return `source ${pole}: head incohérent avec le statut`;
  if (pole === "A" && !(text(s.testFile, 200) && /^studio\/src\/lib\/sav\/cases\/[\w.-]+\.test\.ts$/.test(s.testFile as string))) return "source A: fichier de test illisible";
  return null;
}

function checkCase(v: unknown, cVerified: boolean): string | null {
  const c = v as Record<string, unknown>;
  if (!keys(v, ["ref", "title", "subject", "message", "ticket", "reading", "hand", "owner", "cause", "situation", "today", "flow", "identities", "next", "evidence", "downstream"])) return "cas: champs inattendus";
  if (!oneOf(REFS, c.ref)) return "cas: référence inconnue";
  const ref = c.ref as string;
  for (const k of ["title", "subject", "message", "ticket", "situation", "today", "next"]) if (!text(c[k])) return `${ref}: ${k} illisible`;
  if (!oneOf(PILOT_READINGS, c.reading) || !oneOf(PILOT_HANDS, c.hand) || !oneOf(PILOT_OWNERS, c.owner)) return `${ref}: valeur hors liste`;
  // Who has the hand follows from the reading: only a confirmed dedicated owner gives the agent the case; unknown is never empty nor agent.
  const expected: Record<PilotReading, [PilotHand, PilotOwner[]]> = {
    confirmed: ["agent", ["sav_pilote"]], empty: ["team", ["owner_empty"]], other_person: ["team", ["human"]],
    unknown: ["unread", ["owner_unknown"]], not_read: ["team", ["team_sensitive", "team_rule"]],
  };
  const [hand, owners] = expected[c.reading as PilotReading];
  if (c.hand !== hand || !owners.includes(c.owner as PilotOwner)) return `${ref}: main incohérente avec la lecture du propriétaire`;
  if (c.hand === "agent" ? c.cause !== null : !text(c.cause)) return `${ref}: cause de non-prise absente ou en trop`;
  if (!Array.isArray(c.flow) || c.flow.length < 2 || c.flow.length > 8) return `${ref}: parcours illisible`;
  for (const f of c.flow as unknown[]) {
    const s = f as Record<string, unknown>;
    if (!keys(f, ["step", "value", "basis"]) || !text(s.step, 80) || !text(s.value) || !oneOf(PILOT_BASES, s.basis)) return `${ref}: étape illisible`;
  }
  const id = c.identities as Record<string, unknown>;
  if (!keys(c.identities, ["api", "ticketOwner", "author"]) || !text(id.api) || !text(id.ticketOwner) || !text(id.author)
    || new Set([id.api, id.ticketOwner, id.author]).size !== 3) return `${ref}: identités confondues ou illisibles`;
  if (!Array.isArray(c.evidence) || c.evidence.length < 1 || c.evidence.some(e => !keys(e, ["pole", "test"]) || (e as { pole: unknown }).pole !== "A" || !text((e as { test: unknown }).test, 300)))
    return `${ref}: preuve A absente`;
  const d = c.downstream as Record<string, unknown>;
  if (!keys(c.downstream, ["status", "text"]) || !oneOf(["unverified", "not_applicable"], d.status) || !text(d.text)) return `${ref}: suite B/C illisible`;
  // The agent's case carries C's result; while C is not qualified it must say so, and a team case never claims agent work.
  if (c.hand === "agent" && (cVerified || d.status !== "unverified" || !(d.text as string).startsWith("Résultat non vérifié"))) return `${ref}: résultat de C présenté comme vérifié`;
  if (c.hand !== "agent" && d.status !== "not_applicable") return `${ref}: travail de l'agent sur un dossier qu'il n'a pas`;
  if ((c.flow as { basis: string }[]).some(f => f.basis === "non_verifie") !== (c.hand === "agent")) return `${ref}: étape non vérifiée mal placée`;
  return null;
}

/** Reads the artifact as a whole: any defect rejects it, never a partial pilot. */
export function readPilotEvidence(raw: unknown): PilotEvidenceRead {
  const a = raw as Record<string, unknown>;
  if (!keys(raw, ["schema", "revision", "synthetic", "sources", "cases"])) return { ok: false, reason: "artefact: champs inattendus" };
  if (a.schema !== PILOT_EVIDENCE_SCHEMA || a.revision !== PILOT_EVIDENCE_REVISION) return { ok: false, reason: "artefact: schéma ou révision inconnus" };
  if (a.synthetic !== true) return { ok: false, reason: "artefact: non synthétique" };
  if (!keys(a.sources, ["A", "C"])) return { ok: false, reason: "artefact: sources attendues A et C" };
  const sources = a.sources as Record<string, unknown>;
  const bad = source(sources.A, "A") ?? source(sources.C, "C");
  if (bad) return { ok: false, reason: bad };
  if ((sources.A as { status: string }).status !== "author_tested") return { ok: false, reason: "source A: non testée" };
  // Nothing that looks like an owner, portal or user identifier: five digits or more anywhere but in the commit heads.
  const flat = JSON.stringify({ ...a, sources: { A: { ...(sources.A as object), head: "" }, C: { ...(sources.C as object), head: "" } } });
  if (/\d{5,}/.test(flat.replace(/SYN-T-\d{4}/g, ""))) return { ok: false, reason: "artefact: identifiant numérique interdit" };
  if (!Array.isArray(a.cases) || a.cases.length !== REFS.length) return { ok: false, reason: "artefact: nombre de cas inattendu" };
  const cVerified = (sources.C as { status: string }).status === "author_tested";
  for (const c of a.cases) { const r = checkCase(c, cVerified); if (r) return { ok: false, reason: r }; }
  if (new Set(a.cases.map(c => (c as { ref: string }).ref)).size !== REFS.length) return { ok: false, reason: "artefact: références en double" };
  return { ok: true, evidence: raw as PilotEvidence };
}
