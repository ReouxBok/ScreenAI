import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../simulation-fixtures/syn-rehearsal-report.common-1.r2.json";

// Rehearsal page: the nominal path goes through the REAL port to B's REAL r2 fixture, unchanged. The port is only overridden to
// test the failure states. No network, no write, no file read beyond the fixed fixture.
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const mocks = vi.hoisted(() => ({ staff: vi.fn(), override: undefined as undefined | null | ReturnType<typeof vi.fn>, realCalls: 0 }));
vi.mock("@/lib/sav/intake/console-auth", () => ({ requireIntakeConsoleStaff: mocks.staff }));
vi.mock("../simulation-report-port", async importOriginal => {
  const real = await importOriginal<typeof import("../simulation-report-port")>();
  const counted = real.simulationReportSource && (async () => { mocks.realCalls += 1; return real.simulationReportSource!(); });
  return { get simulationReportSource() { return mocks.override === undefined ? counted : mocks.override; } };
});
vi.mock("next/link", () => ({ default: (props: ComponentProps<"a">) => createElement("a", props) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/studio/sav/v2/simulation", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ back: vi.fn(), refresh: vi.fn() }) }));
import SimulationPage from "./page";

const render = async () => renderToStaticMarkup(await SimulationPage());

beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("fetch", () => { throw Error("NETWORK_FORBIDDEN"); });
  mocks.staff.mockResolvedValue({ email: "operateur@example.test", role: "member" });
  mocks.override = undefined; mocks.realCalls = 0;
});

describe("rehearsal page: staff first, one fixed source, every state distinct, escaped, nothing to act on", () => {
  it("real port → real r2 fixture: provenance, phases, totals, a red double send over two keys, per-key sends, unmeasured sends, simulated actions", async () => {
    const html = await render();
    expect(mocks.realCalls).toBe(1);
    for (const text of ["Répétition V2 (simulation)", "Synthétique", "rien n’est parti", "Contrat sav-v2-simulation-report.common-1",
      "Attendus figés le 2026-10-31T00:29:59.309Z, passage lancé le 2026-10-31T00:29:59.316Z", "19ef4900a9e95c8008de94c60b4bc8b9dfffb827 (arbre 1f757e6c) : code exact qui a produit le rapport",
      "Empreinte du rapport relu", "Conformes : 6 · refus attendus obtenus : 1", "Différents : 1 · incohérents : 0", "Non comparables : 2 · non probants : 0 · invalides : 0",
      "Double envoi simulé dans 1 dossier", "Double envoi : 2 envois synthétiques sur 2 clés de réponse", "sends.total : attendu 1, obtenu 2",
      "Envois non mesurés : l’exécuteur n’a pas tourné.", "effect.reason : executor_not_run", "Aurait été envoyée (Gmail synthétique : rien n’est parti)",
      "Règle B7 non décidée : au plus un envoi attendu.", "par rôle non décidé", "Appels payants : 0", "latence non mesurée"]) expect(html).toContain(text);
    // B08 is two keys sent once each (the B7 limit): a double send for the case, no key sent twice.
    expect(html).not.toContain("Même clé de réponse envoyée plusieurs fois");
    expect(html).not.toMatch(/<form|<button|type="submit"/);
  });

  it("T1: a refused role reads nothing", async () => {
    mocks.staff.mockRejectedValueOnce(Error("FORBIDDEN"));
    await expect(render()).rejects.toThrow("FORBIDDEN");
    expect(mocks.realCalls).toBe(0);
  });

  it("T2/T3/T4: not connected, unavailable and invalid are distinct and never shown as an empty or green report", async () => {
    mocks.override = null;
    expect(await render()).toContain("Aucun rapport de répétition n’est branché sur cette version : cela ne veut pas dire qu’aucun n’existe.");
    mocks.override = vi.fn(async () => { throw Error("READ"); });
    expect(await render()).toContain("Rapport de répétition indisponible : la lecture a échoué. Ce n’est pas un rapport vide.");
    mocks.override = vi.fn(async () => { const r = structuredClone(fixture) as Json; r.cases[0].executor.sendsByReplyKey = 1; return r; });
    const invalid = await render();
    expect(invalid).toContain("envois par clé absents ou incohérents dans SYN-B01 : rapport rejeté");
    expect(invalid).not.toContain("Conformes");
  });

  it("a key sent twice is shown apart from the case total", async () => {
    mocks.override = vi.fn(async () => { const r = structuredClone(fixture) as Json; r.cases[7].executor.sendsByReplyKey[0].count = 2; r.cases[7].executor.sendsByReplyKey[1].count = 0; return r; });
    expect(await render()).toContain(`Même clé de réponse envoyée plusieurs fois : ${fixture.cases[7]!.executor.sendsByReplyKey![0]!.replyKey} : 2`);
  });

  it("a store refusal situation_already_answered reads as already answered, read-only: no button, no form, no resend wording", async () => {
    mocks.override = vi.fn(async () => { const r = structuredClone(fixture) as Json; r.cases[1].refusals = ["situation_already_answered"]; r.cases[1].fields.find((f: Json) => f.field === "refusals").proposed = ["situation_already_answered"]; return r; });
    const html = await render();
    expect(html).toContain("Refus : Situation déjà répondue : une autre réponse est déjà validée, en file ou partie pour ce même mail du client ; refus, rien n’est renvoyé (situation_already_answered)");
    expect(html).not.toMatch(/<form|<button|type="submit"|renvoyer|réessayer/i);
  });

  it("T13: hostile text from the report is escaped; no link is built from the report", async () => {
    const hostile = '<script>alert(1)</script>"><img src=x onerror=alert(1)>';
    mocks.override = vi.fn(async () => { const r = structuredClone(fixture) as Json; r.cases[8].scenario = hostile; r.cases[8].proofs[0].ref = "javascript:alert(1)"; r.run.provenance.cohort.selection = hostile; return r; });
    const html = await render();
    // Real tags only: the escaped text itself may read "onerror="; its quote is escaped, so no attribute can break out.
    expect(html).not.toMatch(/<script|<img|href="javascript/i);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
    expect(html.match(/href="/g) ?? []).toHaveLength(1); // the way back only
  });
});

describe("rehearsal source and imports", () => {
  it("T15: the page takes no URL parameter and imports no fs, path, writer, model, CRM or Gmail module; the port only imports B's r2 fixture", () => {
    const page = readFileSync(path.join(__dirname, "page.tsx"), "utf8"), port = readFileSync(path.join(__dirname, "..", "simulation-report-port.ts"), "utf8");
    expect(page).not.toMatch(/searchParams|params/);
    expect(page.split("\n").filter(line => line.startsWith("import"))).toEqual([
      'import { requireIntakeConsoleStaff } from "@/lib/sav/intake/console-auth";', 'import { BackLink } from "@/components/ui/back-link";',
      'import { Badge, PageHeader, Status } from "@/components/ui/primitives";', 'import { readSimulationReport, type SimulationReportRead } from "../simulation-report";',
      'import { simulationReportSource } from "../simulation-report-port";', 'import styles from "../v2.module.css";']);
    expect(port).not.toMatch(/^import /m);
    expect(port.match(/import\(([^)]*)\)/g)).toEqual(['import("./simulation-fixtures/syn-rehearsal-report.common-1.r2.json")']);
    expect(port).not.toMatch(/searchParams|readFile|node:fs|process\.env\.(?!NODE_ENV)/);
  });

  it("the committed fixture is B's r2 file byte for byte; the port is off in a production build and returns it unchanged otherwise", async () => {
    const bytes = readFileSync(path.join(__dirname, "..", "simulation-fixtures", "syn-rehearsal-report.common-1.r2.json"));
    expect((await import("node:crypto")).createHash("sha256").update(bytes).digest("hex")).toBe("400f53265ef9258018ed711b66af790c98978eea75469b02d41ac1867c9f907e");
    vi.doUnmock("../simulation-report-port");
    vi.resetModules(); vi.stubEnv("NODE_ENV", "production");
    expect((await import("../simulation-report-port")).simulationReportSource).toBeNull();
    vi.resetModules(); vi.stubEnv("NODE_ENV", "test");
    const source = (await import("../simulation-report-port")).simulationReportSource;
    expect(await source!()).toEqual(JSON.parse(bytes.toString("utf8")));
    vi.unstubAllEnvs();
  });
});
