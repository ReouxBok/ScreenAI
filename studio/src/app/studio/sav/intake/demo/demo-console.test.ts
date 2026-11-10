import { createElement, Fragment, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isNavItemActive } from "@/components/studio-navigation";

// The SYN demonstration of the V2 cases (three John cases, seven access pilot cases read from a versioned evidence artifact) in the real console (Agent SAV > Demandes): 404 in production, staff first,
// counters, rows and details from the same objects, list → detail → back keeping the filter and the case anchor. No network, no write.
const mocks = vi.hoisted(() => ({ staff: vi.fn(), studio: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/sav/intake/console-auth", () => ({ requireIntakeConsoleStaff: mocks.staff }));
vi.mock("@/lib/auth", () => ({ requireStaff: mocks.studio }));
vi.mock("@/lib/sav/intake/console-store", () => ({ listIntakeConsole: mocks.list }));
vi.mock("../agent-pause-banner", () => ({ AgentPauseBanner: () => null }));
vi.mock("next/link", () => ({ default: (props: ComponentProps<"a">) => createElement("a", props) }));
vi.mock("next/navigation", () => ({ notFound: () => { throw Error("NOT_FOUND"); } }));
import DemoListPage from "./page";
import DemoCasePage from "./[ref]/page";
import IntakeConsolePage from "../page";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DEMO_CASES, DEMO_LIST_PATH, PILOT_EVIDENCE, PILOT_OWNER_FIXTURE, demoListDestination, demoOwnerLabels, demoSetLabels, parseDemoListMemory } from "./demo-cases";
import { pilotHandLabels, pilotReadingLabels, readPilotEvidence, type PilotEvidence } from "./pilot-access-evidence";

const decode = (html: string) => html.replaceAll("&amp;", "&").replaceAll("&#x27;", "'").replaceAll("&quot;", "\"");
const list = async (query: { set?: string; owner?: string; q?: string } = {}) => decode(renderToStaticMarkup(createElement(Fragment, null, await DemoListPage({ searchParams: Promise.resolve(query) }))));
const detail = async (ref: string, returnTo?: string) => decode(renderToStaticMarkup(createElement(Fragment, null,
  await DemoCasePage({ params: Promise.resolve({ ref }), searchParams: Promise.resolve(returnTo === undefined ? {} : { returnTo }) }))));
const rowHrefs = (html: string) => [...html.matchAll(/<a href="([^"]+)" id="((?:demo|acces)-\d)"/g)].map(m => ({ href: m[1], id: m[2] }));
const backHref = (html: string) => html.match(/<a href="([^"]+)"[^>]*>← Retour à la démonstration/)?.[1];
const tabCount = (html: string, label: string) => Number(html.match(new RegExp(`<span>${label}</span><b>(\\d+)</b>`))?.[1]);

beforeEach(() => {
  vi.clearAllMocks(); vi.unstubAllEnvs(); vi.stubGlobal("fetch", () => { throw Error("NETWORK_FORBIDDEN"); });
  mocks.staff.mockResolvedValue({ id: "synthetic", email: "operateur@example.test", role: "member" });
  mocks.studio.mockResolvedValue({ actorId: "synthetic", email: "contact@limova.ai", name: "Compte fictif", role: "member" });
});

describe("demo console: local only, staff first, inside Agent SAV > Demandes", () => {
  it("a production build answers 404 before the staff check, on the list and on a detail; the intake page shows no demo entry", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(list()).rejects.toThrow("NOT_FOUND");
    await expect(detail("demo-1")).rejects.toThrow("NOT_FOUND");
    expect(mocks.studio).not.toHaveBeenCalled();
    mocks.list.mockResolvedValue({ installed: false });
    expect(renderToStaticMarkup(createElement(Fragment, null, await IntakeConsolePage({ searchParams: Promise.resolve({}) })))).not.toContain("/studio/sav/intake/demo");
  });

  it("outside production the real console header links to the demo, and the Demandes menu entry stays active on its pages", async () => {
    mocks.list.mockResolvedValue({ installed: false });
    expect(renderToStaticMarkup(createElement(Fragment, null, await IntakeConsolePage({ searchParams: Promise.resolve({}) })))).toContain("href=\"/studio/sav/intake/demo\">Démonstration V2 (fictive)</a>");
    const requests = { href: "/studio/sav", match: "sav-requests" as const };
    for (const path of ["/studio/sav/intake/demo", "/studio/sav/intake/demo/demo-1"]) expect(isNavItemActive(requests, path)).toBe(true);
  });

  it("a refused Studio session renders nothing; a Studio account without SAV access gets 404, like the hidden Agent SAV menu", async () => {
    mocks.studio.mockRejectedValue(Error("NEXT_REDIRECT"));
    await expect(list()).rejects.toThrow("NEXT_REDIRECT");
    await expect(detail("demo-1")).rejects.toThrow("NEXT_REDIRECT");
    mocks.studio.mockResolvedValue({ actorId: "synthetic", email: "autre@example.test", role: "owner" });
    await expect(list()).rejects.toThrow("NOT_FOUND");
    await expect(detail("demo-1")).rejects.toThrow("NOT_FOUND");
    // The real console's own check is never used nor weakened by the demonstration.
    expect(mocks.staff).not.toHaveBeenCalled();
  });
});

describe("the three cases: owner, proof, next action; demonstration kept apart from the real follow-up", () => {
  it("the list shows the three cases with their current owner, state and next action, says it is fictitious and offers no command", async () => {
    const html = await list();
    for (const c of DEMO_CASES) for (const text of [c.title, c.state, `Responsable actuel : ${demoOwnerLabels[c.owner]}`, `Prochaine action : ${c.next}`]) expect(html).toContain(text);
    expect(html).toContain("Démonstration, pas un suivi réel");
    expect(html).toContain("aucun client, aucun ticket HubSpot, aucun mail réel");
    expect(html.match(/<form/g)).toHaveLength(1);
    const form = html.match(/<form[^>]*>/)![0];
    expect(form).toContain("method=\"get\""); expect(form).toContain("action=\"/studio/sav/intake/demo\"");
    expect(html).not.toMatch(/method="post"|formAction|<button(?![^>]*type="submit")/i);
  });

  it("case 1: admitted, one simulated knowledge read and generation, AI notice, zero send, and the invalidation rule", async () => {
    const html = await detail("demo-1");
    for (const text of ["Agent V2, sous supervision", "Réponse proposée, en attente de validation humaine", "Proposition avec mention IA", "Dossier admis en V2.",
      "Consultations de connaissances : 1", "Réponses générées : 1", "Envois : 0", "aucun n’est mesuré", "n’est plus valable", "Aucun : ce dossier est fictif."]) expect(html).toContain(text);
  });

  it("case 2: same mail on a human ticket, no V2 work at all; case 3: billing first, out of autonomy before investigation, zero work", async () => {
    const two = await detail("demo-2"), three = await detail("demo-3");
    expect(DEMO_CASES[1].message).toBe(DEMO_CASES[0].message);
    for (const html of [two, three]) for (const text of ["Dossier non admis en V2.", "Consultations de connaissances : 0", "Réponses générées : 0", "Envois : 0"]) expect(html).toContain(text);
    for (const text of ["Équipe : propriétaire humain du ticket", "Aucun traitement V2", "Admission : refusée, ticket humain.", "jamais traitée comme « sans propriétaire »"]) expect(two).toContain(text);
    for (const text of ["Équipe : hors autonomie", "Hors autonomie avant investigation", "La facturation prime sur tout le dossier", "Arrêt avant l’investigation.", "sans réponse IA ni apprentissage"]) expect(three).toContain(text);
  });

  it("counters, rows and details read the same state: each tab count is its number of rows, and each row's detail shows the row's owner and state", async () => {
    const all = await list();
    expect(tabCount(all, "Tous les cas")).toBe(DEMO_CASES.length);
    for (const [owner, label] of Object.entries(demoOwnerLabels)) {
      const filtered = await list({ owner }), rows = rowHrefs(filtered);
      expect(tabCount(all, label)).toBe(rows.length);
      expect(tabCount(filtered, label)).toBe(rows.length);
      for (const row of rows) {
        const c = DEMO_CASES.find(x => x.ref === row.id)!;
        expect(c.owner).toBe(owner);
        const html = await detail(row.id);
        expect(html).toContain(label); expect(html).toContain(c.state);
      }
    }
    // The search narrows the counters and the rows together.
    const searched = await list({ q: "facture" });
    expect(tabCount(searched, "Tous les cas")).toBe(2); expect(rowHrefs(searched).map(r => r.id)).toEqual(["demo-3", "acces-3"]);
  });

  it("an unknown filter or case is refused, never shown as an empty list or another case", async () => {
    const html = await list({ owner: "agent" });
    expect(html).toContain("Filtre non reconnu"); expect(rowHrefs(html)).toEqual([]);
    await expect(detail("demo-4")).rejects.toThrow("NOT_FOUND");
    await expect(detail("__proto__")).rejects.toThrow("NOT_FOUND");
  });
});

describe("list → detail → back keeps the filter and the position", () => {
  it("from a filtered and searched list, each row opens its detail whose return link is exactly that list with the row's anchor", async () => {
    const html = await list({ owner: "agent_v2", q: "John" }), rows = rowHrefs(html);
    expect(rows.map(r => r.id)).toEqual(["demo-1"]);
    const url = new URL(rows[0].href, "https://studio.invalid");
    expect(url.pathname).toBe("/studio/sav/intake/demo/demo-1");
    const returnTo = url.searchParams.get("returnTo")!;
    expect(returnTo).toBe("/studio/sav/intake/demo?owner=agent_v2&q=John#demo-1");
    expect(backHref(await detail("demo-1", returnTo))).toBe(returnTo);
    // Back on that list: same filter selected, same rows, and the anchor targets the row that was opened.
    const back = new URL(returnTo, "https://studio.invalid");
    const again = await list({ owner: back.searchParams.get("owner")!, q: back.searchParams.get("q")! });
    expect(again).toMatch(/aria-current="page"><span>Agent V2, sous supervision<\/span>/);
    expect(rowHrefs(again).map(r => r.id)).toEqual(["demo-1"]);
    expect(again).toContain("id=\"demo-1\"");
    expect(again).toContain("value=\"John\"");
  });

  it("every case from the unfiltered list and from each owner tab comes back to its own list", async () => {
    for (const query of [{}, { owner: "human" }, { owner: "team_sensitive" }, { set: "acces" }, { set: "john", owner: "human" }] as { set?: string; owner?: string }[]) for (const row of rowHrefs(await list(query))) {
      const returnTo = new URL(row.href, "https://studio.invalid").searchParams.get("returnTo")!;
      const search = new URLSearchParams(Object.entries(query)).toString();
      const expected = `${DEMO_LIST_PATH}${search ? `?${search}` : ""}#${row.id}`;
      expect(returnTo).toBe(expected);
      expect(backHref(await detail(row.id, returnTo))).toBe(expected);
    }
  });

  it("a forged return link falls back to the demo list, never to another page, the real console, a foreign site or an unknown filter", async () => {
    for (const forged of ["https://evil.example/x", "//evil.example", "/studio/sav/intake?view=processing", "/studio/sav/v2", "/studio/sav/intake", "/studio#demo-1", "/studio/sav/intake/demo?owner=root",
      "/studio/sav/intake/demo?owner=human&owner=agent_v2", "/studio/sav/intake/demo?x=1", "/studio/sav/intake/demo?set=pilote", "/studio/sav/intake/demo?set=acces&set=john", "/studio/sav/intake/demo#dossier-1", "javascript:alert(1)", "/studio/sav/intake/demo\\..\\x"]) {
      expect(demoListDestination(forged)).toBeNull();
      expect(backHref(await detail("demo-2", forged))).toBe(DEMO_LIST_PATH);
    }
    expect(backHref(await detail("demo-2"))).toBe(DEMO_LIST_PATH);
  });

  it("the remembered scroll position is accepted only for the demo list and a known case", () => {
    expect(parseDemoListMemory(JSON.stringify({ href: "/studio/sav/intake/demo?owner=human", y: 420, focusId: "demo-2" }))).toEqual({ href: "/studio/sav/intake/demo?owner=human", y: 420, focusId: "demo-2" });
    for (const bad of [{ href: "/studio/sav/intake?view=processing", y: 1, focusId: "demo-1" }, { href: DEMO_LIST_PATH, y: -1, focusId: "demo-1" }, { href: DEMO_LIST_PATH, y: 1, focusId: "dossier-x" }])
      expect(parseDemoListMemory(JSON.stringify(bad))).toBeNull();
    expect(parseDemoListMemory("{")).toBeNull();
  });
});

describe("access pilot read from the SYN evidence artifact: who has the hand, why not, owner unknown apart from empty, C unverified", () => {
  const acces = DEMO_CASES.filter(c => c.set === "acces");
  const artifact = () => JSON.parse(readFileSync(new URL("./fixtures/pilot-access-evidence.v1.json", import.meta.url), "utf8"));

  it("the artifact is the pinned revision 1, synthetic, citing pole A at its exact head and pole C as unverified; it validates as a whole", () => {
    const bytes = readFileSync(new URL("./fixtures/pilot-access-evidence.v1.json", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("a5d427c35835632d6467d59830cce337bd50645989522f32841c48dce04fee90");
    const read = readPilotEvidence(artifact());
    expect(read.ok).toBe(true);
    expect(PILOT_EVIDENCE.ok).toBe(true);
    const { sources } = (read as { ok: true; evidence: PilotEvidence }).evidence;
    expect(sources.A).toMatchObject({ status: "author_tested", head: "fdb7199bfd3579584b3ae64d8fdf1a50b53b7d53", testFile: "studio/src/lib/sav/cases/pilot-access-attribution.compose.test.ts" });
    expect(sources.C).toMatchObject({ status: "unverified", head: null });
    expect(acces.map(c => c.ref)).toEqual(["acces-1", "acces-2", "acces-3", "acces-4", "acces-5", "acces-6", "acces-7"]);
  });

  it("any defect rejects the whole artifact: never a partial pilot, never C passed off as verified, never unknown read as empty or as the agent", () => {
    type RawCase = { ref: string; title: string; hand: string; owner: string; cause: string | null; flow: { basis: string }[];
      identities: { author: string; ticketOwner: string }; evidence: unknown[]; downstream: { status: string; text: string } };
    type Raw = { revision: number; synthetic: boolean; live?: boolean; sources: { A: { head: string | null }; C: { status: string; head: string | null; result?: string } }; cases: RawCase[] };
    const mutate = (f: (a: Raw) => void) => { const a = artifact() as Raw; f(a); return readPilotEvidence(a); };
    const broken: Record<string, (a: Raw) => void> = {
      revision: a => { a.revision = 2; }, notSynthetic: a => { a.synthetic = false; }, extraField: a => { a.live = true; },
      cClaimsTestedWithoutHead: a => { a.sources.C.status = "author_tested"; },
      cTested: a => { a.sources.C = { status: "author_tested", head: "a".repeat(40), result: "qualifié" }; },
      aWithoutHead: a => { a.sources.A.head = null; },
      unknownAsEmpty: a => { a.cases[4].hand = "team"; a.cases[4].owner = "owner_empty"; },
      unknownAsAgent: a => { a.cases[4].hand = "agent"; a.cases[4].owner = "sav_pilote"; a.cases[4].cause = null; },
      emptyAsAcquired: a => { a.cases[3].hand = "agent"; a.cases[3].owner = "sav_pilote"; a.cases[3].cause = null; },
      teamWithoutCause: a => { a.cases[1].cause = null; },
      agentWithCause: a => { a.cases[0].cause = "x"; },
      agentResultVerified: a => { a.cases[0].downstream = { status: "not_applicable", text: "Réponse envoyée." }; },
      teamCaseWithAgentWork: a => { a.cases[2].downstream.status = "unverified"; },
      unverifiedStepOnTeamCase: a => { a.cases[1].flow[0].basis = "non_verifie"; },
      unknownBasis: a => { a.cases[0].flow[0].basis = "hypothese"; },
      identitiesMerged: a => { a.cases[0].identities.author = a.cases[0].identities.ticketOwner; },
      ownerIdWritten: a => { a.cases[0].identities.ticketOwner = "SAV Pilote 90000042"; },
      markup: a => { a.cases[0].title = "<script>x</script>"; },
      duplicateRef: a => { a.cases[6].ref = "acces-1"; },
      missingCase: a => { a.cases.pop(); },
      noProof: a => { a.cases[0].evidence = []; },
    };
    for (const [name, f] of Object.entries(broken)) expect({ name, ok: mutate(f).ok }).toEqual({ name, ok: false });
  });

  it("a rejected artifact shows an alert and no pilot case at all, while the John cases stay", async () => {
    vi.resetModules();
    vi.doMock("./fixtures/pilot-access-evidence.v1.json", () => ({ default: { ...artifact(), revision: 2 } }));
    try {
      const { default: Page } = await import("./page");
      const html = decode(renderToStaticMarkup(createElement(Fragment, null, await Page({ searchParams: Promise.resolve({}) }))));
      expect(html).toContain("Preuves du pilote accès illisibles");
      expect(html).toContain("schéma ou révision inconnus");
      expect(rowHrefs(html).map(r => r.id)).toEqual(["demo-1", "demo-2", "demo-3"]);
      expect(tabCount(html, "Pilote accès")).toBe(0);
    } finally { vi.doUnmock("./fixtures/pilot-access-evidence.v1.json"); vi.resetModules(); }
  });

  it("the John cases stay available unchanged next to the seven pilot cases, each journey with its own counters", async () => {
    expect(DEMO_CASES.filter(c => c.set === "john").map(c => c.ref)).toEqual(["demo-1", "demo-2", "demo-3"]);
    const all = await list();
    expect(rowHrefs(all).map(r => r.id)).toEqual(DEMO_CASES.map(c => c.ref));
    expect(tabCount(all, demoSetLabels.john)).toBe(3); expect(tabCount(all, demoSetLabels.acces)).toBe(7);
    for (const [set, label] of Object.entries(demoSetLabels)) {
      const html = await list({ set });
      expect(rowHrefs(html).map(r => r.id)).toEqual(DEMO_CASES.filter(c => c.set === set).map(c => c.ref));
      expect(html).toMatch(new RegExp(`aria-current="page"><span>${label}</span>`));
    }
    const john = await list({ set: "john" });
    for (const c of DEMO_CASES.slice(0, 3)) for (const text of [c.title, c.state, `Responsable actuel : ${demoOwnerLabels[c.owner]}`]) expect(john).toContain(text);
    expect(john).not.toContain("qui a la main"); expect(john).not.toContain("Production aujourd’hui");
    expect(await detail("demo-1")).not.toContain("Trois identités");
  });

  it("agent / team view: the hand summary counts the rows shown, each row says who has the hand and, if not the agent, why", async () => {
    const hands = (html: string) => Object.fromEntries([...html.matchAll(/data-hand="(\w+)">[^<]+ : (\d+)<\/span>/g)].map(m => [m[1], Number(m[2])]));
    const html = await list({ set: "acces" });
    expect(hands(html)).toEqual({ agent: 1, team: 5, unread: 1 });
    expect(hands(html)).toEqual(Object.fromEntries(["agent", "team", "unread"].map(h => [h, acces.filter(c => c.pilot!.hand === h).length])));
    for (const c of acces) {
      const row = html.slice(html.indexOf(`id="${c.ref}"`), html.indexOf("</a>", html.indexOf(`id="${c.ref}"`)));
      expect(row).toContain(`data-hand="${c.pilot!.hand}">${pilotHandLabels[c.pilot!.hand]}</span>`);
      expect(row).toContain(`Production aujourd’hui : ${c.pilot!.today}`);
      if (c.pilot!.hand === "agent") expect(row).not.toContain("Cause de non-prise"); else expect(row).toContain(`Cause de non-prise : ${c.pilot!.cause}`);
    }
    // A tab narrows the summary with the rows: the unknown-owner tab shows one unread row and no team.
    expect(hands(await list({ set: "acces", owner: "owner_unknown" }))).toEqual({ agent: 0, team: 0, unread: 1 });
  });

  it("owner unknown is never shown as empty: different tab, reading, hand and cause; neither gives the agent the case", async () => {
    const empty = await detail("acces-4"), unknown = await detail("acces-5");
    // Fixed wording, not read back from the module: an unknown owner must never carry the empty owner's words.
    expect(empty).toContain("<dt>Lecture du propriétaire</dt><dd>Sans propriétaire (vide)</dd>");
    expect(unknown).toContain("<dt>Lecture du propriétaire</dt><dd>Inconnu (non lisible)</dd>");
    expect(new Set(Object.values(pilotReadingLabels)).size).toBe(Object.keys(pilotReadingLabels).length);
    expect(empty).toContain(`data-hand="team"`); expect(unknown).toContain(`data-hand="unread"`);
    expect(empty).toContain("Responsable actuel</h2><p><strong>Équipe : sans propriétaire, non acquis</strong>");
    expect(unknown).toContain("Responsable actuel</h2><p><strong>Non lu : propriétaire inconnu</strong>");
    expect(unknown).toContain("Ce n’est ni « vide » ni « SAV Pilote ».");
    for (const html of [empty, unknown]) { expect(html).not.toContain(`data-hand="agent"`); expect(html).toContain("Cause de non-prise"); }
  });

  it("pilot 1: the agent has the hand only through A's tested route; production today stays with the team; C's result is said unverified", async () => {
    const html = await detail("acces-1");
    const steps = ["Mail reçu (V1)", "Création du ticket par V1", "Admission", "Lecture du propriétaire", "Qui a la main", "Réponse préparée (C)"].map(s => html.indexOf(`<strong>${s}</strong>`));
    expect(steps.every(i => i > 0)).toBe(true); expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(html).toMatch(/<strong>Réponse préparée \(C\)<\/strong><p>Résultat non vérifié[^<]*<\/p><span[^>]*data-basis="non_verifie">Résultat non vérifié</);
    expect(html).toMatch(/<strong>Lecture du propriétaire<\/strong><p>SAV Pilote confirmé[^<]*<\/p><span[^>]*data-basis="a_teste">Testé localement par A \(SYN\)</);
    expect(html).toContain(`data-hand="agent">Agent</span>`); expect(html).toContain("Pourquoi l’agent");
    expect(html).toContain("<h3>Production aujourd’hui</h3><p><strong>Équipe : aujourd’hui V1 crée les tickets sans propriétaire, aucun dossier n’atteint l’agent.</strong>");
    expect(html).toMatch(/data-status="unverified"><h3>Suite de B et C<\/h3><p>Résultat non vérifié/);
    for (const text of ["head fdb7199", "Pôle C · Livraison non commitée et non qualifiée", "confirmed: a ticket V1 created with the dedicated owner",
      "Propriétaire absent ne veut pas dire acquis", "La prise n’est jamais garantie", "Une réponse préparée n’est pas une réponse envoyée."]) expect(html).toContain(text);
    expect(html).not.toContain("Ce que l’agent V2 a fait");
  });

  it("team cases: no unverified step, no agent work, the cause shown; access + billing and pause never read the owner", async () => {
    for (const c of acces.filter(x => x.pilot!.hand !== "agent")) {
      const html = await detail(c.ref);
      expect(html).not.toContain("data-basis=\"non_verifie\""); expect(html).not.toContain("Ce que l’agent V2 a fait");
      if (c.pilot!.hand === "team") expect(html).toContain("Aucun dossier n’est donné à l’agent");
      expect(html).toContain(c.pilot!.cause!);
    }
    for (const ref of ["acces-3", "acces-6", "acces-7"]) expect(await detail(ref)).toContain(`<dd>${pilotReadingLabels.not_read}</dd>`);
    expect(await detail("acces-7")).toContain("le mail est enregistré, l’agent ne prend rien");
  });

  it("the API identity, the HubSpot ticket owner and the author are distinct; no owner identifier in the demonstration's code or artifact", () => {
    for (const c of acces) {
      const { api, ticketOwner, author } = c.pilot!.identities;
      expect(new Set([api, ticketOwner, author]).size).toBe(3); expect(api).not.toContain(PILOT_OWNER_FIXTURE.name);
    }
    expect(PILOT_OWNER_FIXTURE).toEqual({ name: "SAV Pilote", ownerId: null, confirmed: false, source: "fixture injectée par la démonstration" });
    for (const file of ["./demo-cases.ts", "./pilot-access-evidence.ts", "./fixtures/pilot-access-evidence.v1.json"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8").replace(/SYN-T-\d{4}|\b[0-9a-f]{40}\b|\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "");
      expect({ file, id: /\d{5,}/.test(source) }).toEqual({ file, id: false });
    }
  });

  it("no pilot page claims a sent reply, a production pilot or a resolution, and none offers a command", async () => {
    for (const c of acces) expect(await detail(c.ref)).not.toMatch(/a été envoyée|est envoyée|prêt pour la production|pilote actif|résolu|<form|<button/i);
  });

  it("list → pilot detail → back keeps the journey, the owner tab, the search and the row", async () => {
    const html = await list({ set: "acces", owner: "owner_unknown", q: "connexion" }), rows = rowHrefs(html);
    expect(rows.map(r => r.id)).toEqual(["acces-5"]);
    const returnTo = new URL(rows[0].href, "https://studio.invalid").searchParams.get("returnTo")!;
    expect(returnTo).toBe("/studio/sav/intake/demo?set=acces&owner=owner_unknown&q=connexion#acces-5");
    expect(backHref(await detail("acces-5", returnTo))).toBe(returnTo);
    const again = await list({ set: "acces", owner: "owner_unknown", q: "connexion" });
    expect(again).toMatch(/aria-current="page"><span>Pilote accès<\/span>/);
    expect(again).toMatch(/aria-current="page"><span>Non lu : propriétaire inconnu<\/span>/);
    expect(again).toContain("value=\"connexion\""); expect(again).toContain("name=\"set\" value=\"acces\"");
    expect(again).toContain("href=\"/studio/sav/intake/demo?set=john&q=connexion\"");
  });
});

describe("operator reading of the pilot: one reason, French wording, no empty tab", () => {
  const acces = DEMO_CASES.filter(c => c.set === "acces");
  const count = (html: string, text: string) => html.split(text).length - 1;

  it("each pilot detail states its reason once (in « Qui a la main »); the John details keep theirs under « Responsable actuel »", async () => {
    for (const c of acces) {
      const html = await detail(c.ref);
      expect({ ref: c.ref, times: count(html, c.ownerWhy) }).toEqual({ ref: c.ref, times: 1 });
      expect(html).toMatch(/<h2 id="demo-hand">Qui a la main<\/h2>[\s\S]*<dd>[^<]*<\/dd><\/div><\/dl><\/section>/);
      expect(html.slice(html.indexOf("demo-owner"), html.indexOf("demo-hand"))).not.toContain(c.ownerWhy);
    }
    for (const c of DEMO_CASES.filter(x => x.set === "john")) expect(count(await detail(c.ref), c.ownerWhy)).toBe(1);
  });

  it("the raw English test titles only appear inside the collapsed technical references; the operator text says what A tested, in French", async () => {
    for (const c of acces) {
      const html = await detail(c.ref);
      const technical = html.match(/<details[^>]*><summary>Références techniques \(titres des tests du pôle A\)<\/summary>[\s\S]*?<\/details>/)?.[0] ?? "";
      for (const e of c.pilot!.evidence) { expect(technical).toContain(e.test); expect(html.replace(technical, "")).not.toContain(e.test); }
      // Visible text only (tags and attributes such as aria-labelledby="demo-owner" are not operator text).
      const visible = html.replace(technical, "").replace(/<[^>]+>/g, " ");
      expect(visible).not.toMatch(/\b(the|a ticket|owner|goes to|stays with|records nothing)\b/);
      for (const f of c.pilot!.flow.filter(x => x.basis === "a_teste")) expect(html).toContain(`Testé localement par A · ${f.step} : ${f.value}`);
    }
  });

  it("an owner tab with no case in the journey is hidden, unless selected; a search with no match hides no tab", async () => {
    const tabs = (html: string) => [...(html.match(/<nav aria-label="Responsable actuel"[\s\S]*?<\/nav>/)?.[0] ?? "").matchAll(/<span>([^<]+)<\/span><b>(\d+)<\/b>/g)].map(m => m[1]);
    const pilotOwners = ["sav_pilote", "owner_empty", "owner_unknown", "team_rule"].map(o => demoOwnerLabels[o as keyof typeof demoOwnerLabels]);
    expect(tabs(await list())).toEqual(["Tous les cas", ...Object.values(demoOwnerLabels)]);
    const acc = tabs(await list({ set: "acces" }));
    expect(acc).not.toContain(demoOwnerLabels.agent_v2); expect(acc).toEqual(expect.arrayContaining(pilotOwners));
    const john = tabs(await list({ set: "john" }));
    expect(john).toEqual(["Tous les cas", demoOwnerLabels.agent_v2, demoOwnerLabels.human, demoOwnerLabels.team_sensitive]);
    // Selected even though empty in the journey: still shown, current, at 0.
    const selected = await list({ set: "john", owner: "owner_unknown" });
    expect(selected).toMatch(/aria-current="page"><span>Non lu : propriétaire inconnu<\/span><b>0<\/b>/);
    // A search that matches nothing keeps the journey's tabs (at 0) rather than hiding them.
    expect(tabs(await list({ set: "acces", q: "introuvable" }))).toEqual(acc);
  });
});
