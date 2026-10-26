/** Independent qualification — C. Email context, section provenance and citations.
 * Pure derivation tests plus the real runtime store on PGlite with a fake model
 * transport whose calls are counted. See test/sav-qualification.ts. */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { targetIt } from "../../../../test/sav-qualification";
import { savMailboxes, savMessages, savThreads, savIntakeRuns, savIntakeModelCalls, savActions, savIntakeJournal } from "@/db/schema";
import { SAV_INTAKE_ATTEMPT_POLICY } from "./attempt-policy";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
import { encryptSavPayload } from "../crypto";
import { prepareSavIntakeMessage } from "./message";
import { createSavIntakeSemanticReaders, type IntakeGeminiCall } from "./model-readers";
import { SAV_INTAKE_MODEL_LIMITS } from "./model-limits";
import { intakeRuntimeHash, savIntakeRuntimeConfig, type IntakeRuntimeConfig } from "./runtime-contract";
import { claimSavIntakeRun, enqueueSavIntakeMessage, failSavIntakeRun, pendingSavIntakeRuns, readSavIntakeCurrent } from "./runtime-store";
import { analyseSavIntakeRuntime } from "./runtime";

const CURRENT = "Bonjour, depuis ce matin la synchronisation de mon agenda échoue avec une erreur 500.";
const OLD_REQUEST = "Je veux résilier mon abonnement immédiatement.";
const quoteBlock = (chars: number) => {
  const lines = [`Le lun. 6 oct. 2026 à 10:00, Support <support@example.invalid> a écrit :`];
  let n = 0;
  while (lines.join("\n").length < chars) lines.push(`> Historique synthétique ligne ${++n}. ${n === 3 ? OLD_REQUEST : "Rien à signaler."}`);
  return lines.join("\n");
};
const signatureBlock = (chars: number) => {
  const lines = ["--", "Camille Exemple", "Responsable fictive"];
  let n = 0;
  while (lines.join("\n").length < chars) lines.push(`Mention légale synthétique ${++n} — société fictive, capital fictif.`);
  return lines.join("\n");
};
const base = (body: string, overrides: Partial<Parameters<typeof prepareSavIntakeMessage>[0]> = {}) => prepareSavIntakeMessage({
  id: randomUUID(), threadId: randomUUID(), receivedAt: new Date().toISOString(), fromEmail: "client@example.invalid", toEmails: ["support@example.invalid"],
  direction: "inbound", subject: "Re: Synchronisation agenda", body, bodyComplete: true, unresolvedAttachments: false, ...overrides });

describe("pure derivation", () => {
  it("[INV] C1 quoted history never becomes the current request, whatever its length", () => {
    for (const size of [500, 4_500, 20_000]) {
      const { message, provenance } = base(`${CURRENT}\n\n${quoteBlock(size)}`);
      expect(message.currentText).toContain(CURRENT);
      expect(message.currentText).not.toContain(OLD_REQUEST);
      expect(message.currentText).not.toContain("Historique synthétique");
      // When the quote is declared complete, its provenance must not be silently cut.
      if (message.contentComplete) expect(provenance.quotedText).toContain(OLD_REQUEST);
    }
  });

  it("[INV] C2 a complete current text is never a silent prefix of the authored section", () => {
    const longCurrent = Array.from({ length: 400 }, (_, i) => `Étape ${i + 1}: la synchronisation échoue encore sur le calendrier ${i}.`).join("\n");
    expect(longCurrent.length).toBeGreaterThan(12_000);
    const { message, provenance } = base(`${longCurrent}\n\n${quoteBlock(500)}`);
    if (message.contentComplete) expect(message.currentText).toContain(longCurrent.split("\n").at(-1)!);
    else expect(provenance.truncated || !provenance.textComplete).toBe(true);
  });

  it("[INV] C3 interleaved replies (>100 sections): complete only if every authored line survives", () => {
    const lines: string[] = [];
    for (let i = 0; i < 70; i++) lines.push(`Réponse intercalée ${i}: oui pour le point ${i}.`, `> Question support ${i} ?`);
    const { message, provenance } = base(lines.join("\n"));
    if (!message.contentComplete) expect(provenance.truncated || !provenance.textComplete).toBe(true);
    if (message.contentComplete) for (let i = 0; i < 70; i++) expect(message.currentText).toContain(`Réponse intercalée ${i}:`);
    expect(message.currentText).not.toContain("Question support");
  });

  it.each([
    ["body_incomplete", { bodyComplete: false }],
    ["unresolved_attachment", { unresolvedAttachments: true }],
  ] as const)("[INV] C4 %s remains signalled as incomplete", (_name, overrides) => {
    expect(base(`${CURRENT}\n\n${quoteBlock(5_000)}`, overrides).message.contentComplete).toBe(false);
  });

  it("[INV] C4b unclosed HTML document and HTML quotation stay incomplete", () => {
    expect(base(`<html><body><p>${CURRENT}</p>`).message.contentComplete).toBe(false);
    expect(base(`<html><body><p>${CURRENT}</p><div class="gmail_quote">${OLD_REQUEST}</div></body></html>`).message.contentComplete).toBe(false);
  });

  it("[INV] C4c a body at the storage bound is never complete", () => {
    expect(base(`${CURRENT}\n${"x ".repeat(50_000)}`).message.contentComplete).toBe(false);
  });

  it("[REPRO→NR] C5: base refuses a mail for a 4 001+ char quote; fixed code keeps it complete", () => {
    const quoted = base(`${CURRENT}\n\n${quoteBlock(4_500)}`), signed = base(`${CURRENT}\n${signatureBlock(2_500)}`);
    if (process.env.SAV_QUALIFICATION_TARGET === "1") {
      expect(quoted.message.contentComplete).toBe(true); expect(quoted.provenance.truncated).toBe(false);
      expect(signed.message.contentComplete).toBe(true); return;
    }
    expect(quoted.message.contentComplete).toBe(false);
    expect(quoted.provenance.truncated).toBe(true);
    expect(signed.message.contentComplete).toBe(false);
  });

  targetIt("[CIBLE] C5 long quotation/signature keep a complete current request and full, attributed sections", () => {
    const quote = quoteBlock(4_500), signature = signatureBlock(2_500);
    const { message, provenance } = base(`${CURRENT}\n${signature}\n\n${quote}`);
    expect(message.contentComplete).toBe(true);
    expect(message.currentText).toContain(CURRENT);
    expect(message.currentText).not.toContain(OLD_REQUEST);
    expect(JSON.stringify(provenance)).toContain(OLD_REQUEST);
    expect(JSON.stringify(provenance)).toContain(signature.split("\n").at(-1)!);
  });
});

describe("complete sections and provenance (PR158)", () => {
  targetIt("[CIBLE] C13 every section is kept verbatim with its provenance; history stays out of currentText", () => {
    const longCurrent = Array.from({ length: 300 }, (_, i) => `Point ${i}: la synchronisation échoue sur le calendrier ${i}.`).join("\n");
    const quote = quoteBlock(9_000), signature = signatureBlock(3_000);
    const { message, provenance } = base(`${longCurrent}\n${signature}\n\n${quote}`);
    expect(longCurrent.length).toBeGreaterThan(12_000);
    expect(message.contentComplete).toBe(true);
    expect(message.currentText).toContain(longCurrent.split("\n").at(-1)!);
    expect(message.currentText).not.toContain(OLD_REQUEST);
    const p = provenance as typeof provenance & { currentText?: string };
    expect(p.quotedText).toContain(OLD_REQUEST);
    expect(p.quotedText.length).toBeGreaterThan(8_000);
    expect(p.signatureText).toContain(signature.split("\n").at(-1)!);
    const lines = `${longCurrent}\n${signature}\n\n${quote}`.split("\n").length;
    expect(Math.max(...p.parts.map(x => x.endLine))).toBe(lines);
  });
  targetIt("[CIBLE] C14 at the 100k storage bound the view is never labelled complete", () => {
    const { message, provenance } = base(`${CURRENT}\n${"mot ".repeat(25_000)}`);
    expect(message.contentComplete).toBe(false);
    expect(provenance.truncated).toBe(true);
  });
});

describe("citations against sections", () => {
  const messageId = randomUUID(), threadId = randomUUID();
  const msg = { id: messageId, threadId, receivedAt: new Date().toISOString(), fromEmail: "client@example.invalid", toEmails: ["support@example.invalid"],
    currentText: CURRENT, contentComplete: true, direction: "inbound" as const };
  const prior = { ...msg, id: randomUUID(), receivedAt: new Date(Date.now() - 86_400_000).toISOString(), currentText: OLD_REQUEST };
  function readers(answer: (data: { citationCatalogue: { id: string; sourceId: string; text: string }[] }) => unknown) {
    const calls: unknown[] = [];
    const call: IntakeGeminiCall = async input => {
      calls.push(input.phase);
      const data = JSON.parse(input.body.contents[0].parts[0].text);
      return { json: answer(data), metadata: { inputTokens: 1, outputTokens: 1, thoughtTokens: 0, totalTokens: 2 } as never };
    };
    return { calls, reader: createSavIntakeSemanticReaders({ model: "gemini-3.6-flash", call }) };
  }
  const analysis = (quoteId: string, extra: Record<string, unknown> = {}) => ({ messageId, requests: [{ id: "r1", kind: "support", currentMessageId: messageId, quoteId, ...extra }],
    ticketSummary: { title: "Agenda", description: "Synchronisation en échec.", requestIds: ["r1"] } });

  it("[INV] C6 a request anchored in a prior message (historical) is refused without continuation", async () => {
    const { reader, calls } = readers(d => analysis(d.citationCatalogue.find(e => e.sourceId !== "current")!.id));
    await expect(reader.analyseMessage({ message: msg, conversation: [prior] } as never, AbortSignal.timeout(5000))).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("[INV] C7 unknown anchor, ambiguous quote+quoteId and mismatched sourceId are refused", async () => {
    for (const make of [
      () => analysis("q999"),
      (d: { citationCatalogue: { id: string }[] }) => analysis(d.citationCatalogue[0].id, { quote: CURRENT }),
      (d: { citationCatalogue: { id: string }[] }) => analysis(d.citationCatalogue[0].id, { sourceId: `message-${prior.id}` }),
    ]) {
      const { reader } = readers(make as never);
      await expect(reader.analyseMessage({ message: msg, conversation: [prior] } as never, AbortSignal.timeout(5000))).rejects.toThrow();
    }
  });

  it("[INV] C8 a valid current anchor is accepted and does not leak quoted history into requests", async () => {
    const { reader, calls } = readers(d => analysis(d.citationCatalogue.find(e => e.sourceId === "current")!.id));
    const result = await reader.analyseMessage({ message: msg, conversation: [prior] } as never, AbortSignal.timeout(5000));
    expect(result.requests).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("[INV] C9b a request several times above the former 96 KiB cap is read in one call, complete", async () => {
    const { reader, calls } = readers(d => analysis(d.citationCatalogue.find(e => e.sourceId === "current")!.id));
    const long = Array.from({ length: 4_000 }, (_, i) => `Ligne actuelle ${i} sur la synchronisation.`).join("\n");
    expect(Buffer.byteLength(long)).toBeGreaterThan(160 * 1024);
    const result = await reader.analyseMessage({ message: { ...msg, currentText: long }, conversation: [prior] } as never, AbortSignal.timeout(5000));
    expect(result.requests).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("[INV] C9 payload above the data bound is refused before any provider call, with a bounded trace", async () => {
    const traces: { errorCode: string | null; contextLimit?: { stage: string; limitBytes?: number } }[] = [], calls: unknown[] = [];
    const reader = createSavIntakeSemanticReaders({ model: "gemini-3.6-flash", call: async () => { calls.push(1); throw Error("MUST_NOT_CALL"); }, onTrace: t => traces.push(t) });
    const big = Array.from({ length: Math.ceil(SAV_INTAKE_MODEL_LIMITS.dataBytes / 30) }, (_, i) => `Ligne actuelle ${i} sur la synchronisation.`).join("\n");
    expect(Buffer.byteLength(big)).toBeGreaterThan(SAV_INTAKE_MODEL_LIMITS.dataBytes);
    await expect(reader.analyseMessage({ message: { ...msg, currentText: big }, conversation: [] } as never, AbortSignal.timeout(5000))).rejects.toThrow("SAV_INTAKE_MODEL_CONTEXT_LIMIT");
    expect(calls).toHaveLength(0);
    expect(traces.at(-1)).toMatchObject({ errorCode: "SAV_INTAKE_MODEL_CONTEXT_LIMIT" });
    expect(JSON.stringify(traces)).not.toContain("Ligne actuelle");
    // Building a catalogue over more than 640 KiB of source text takes seconds on a loaded machine.
  }, 30_000);
});

describe("runtime (stored mail → readers → plan)", () => {
  let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, threadId: string, config: IntakeRuntimeConfig, environment: Record<string, string | undefined>;
  function env(mailbox: string, codeRevision = "a".repeat(40)) {
    const policy = { relationRevision: "synthetic-no-associations", admittedRelations: [], resources: {} };
    return { SAV_INTAKE_RUNTIME_MODE: "observe", SAV_CODE_REVISION: codeRevision, SAV_AI_MODEL: "gemini-3.6-flash", SAV_GEMINI_API_KEY: "fake-model", HUBSPOT_ACCESS_TOKEN: "fake-crm",
      SAV_ENCRYPTION_KEY_V1: "synthetic-intake-runtime-encryption-key", SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(policy), SAV_INTAKE_RUNTIME_RESOURCES: "[]",
      SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ mailboxId: mailbox, receivedAfter: new Date(Date.now() - 3600_000).toISOString(), createdAfter: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(), codeRevision, policyHash: intakeRuntimeHash(policy), resourcesHash: intakeRuntimeHash([]), maxNanoUsd: 3_000_000_000, maxCalls: 30 }) };
  }
  async function stored(body: string) {
    const [m] = await f.db.insert(savMessages).values({ mailboxId, threadId, direction: "inbound", fromEmail: "client@example.invalid", toEmails: ["support@example.invalid"],
      subject: "Re: Synchronisation agenda", gmailMessageId: randomUUID(), bodyCiphertext: encryptSavPayload({ text: body, attachments: [], headers: {} }),
      receivedAt: new Date(), createdAt: new Date(), analysisStatus: "pending" }).returning();
    return m;
  }
  /** Counts model and CRM calls. The fake model only cites the server-supplied current anchor. */
  function provider(messageId: string) {
    const counts = { model: 0, crm: 0, other: 0 };
    const network = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(url).startsWith("https://generativelanguage.googleapis.com/")) {
        counts.model++;
        const body = JSON.parse(String(init?.body)), data = JSON.parse(body.contents[0].parts[0].text);
        const anchor = data.citationCatalogue.find((x: { sourceId: string }) => x.sourceId === "current").id;
        const answer = { messageId, requests: [{ id: "support-1", kind: "support", currentMessageId: messageId, quoteId: anchor }],
          ticketSummary: { title: "Synchronisation agenda", description: "La synchronisation échoue.", requestIds: ["support-1"] } };
        return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 150 } });
      }
      if (String(url).startsWith("https://api.hubapi.com/")) { counts.crm++; return Response.json({ total: 0, results: [] }); }
      counts.other++; throw Error("EXTERNAL_NETWORK_FORBIDDEN");
    });
    return { counts, network };
  }
  beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30_000);
  afterAll(async () => { await f?.client.close(); });
  beforeEach(async () => {
    vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-intake-runtime-encryption-key");
    await f.client.exec("TRUNCATE sav.intake_model_calls, sav.mailboxes CASCADE; TRUNCATE public.audit_logs");
    mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0].id;
    threadId = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "client@example.invalid" }).returning())[0].id;
    environment = env(mailboxId); config = savIntakeRuntimeConfig(environment)!;
  });
  afterEach(() => vi.unstubAllEnvs());

  it("[REPRO→NR] C10: base refuses a long quotation before the model; fixed code reaches the model", async () => {
    const m = await stored(`${CURRENT}\n\n${quoteBlock(4_500)}`), id = await enqueueSavIntakeMessage(m.id, config), { counts, network } = provider(m.id);
    await analyseSavIntakeRuntime(id!, config, { env: () => environment, network });
    const current = await readSavIntakeCurrent(threadId, config);
    if (process.env.SAV_QUALIFICATION_TARGET === "1") { expect(counts.model).toBe(1); return; }
    expect(counts.model).toBe(0);
    expect(current?.payload.plan?.decision.disposition).toMatchObject({ kind: "collect_context", reasons: expect.arrayContaining(["classification_incomplete"]) });
  });

  targetIt("[CIBLE] C10 long quotation reaches exactly one understanding call and keeps the current request only", async () => {
    const m = await stored(`${CURRENT}\n\n${quoteBlock(4_500)}`), id = await enqueueSavIntakeMessage(m.id, config), { counts, network } = provider(m.id);
    await analyseSavIntakeRuntime(id!, config, { env: () => environment, network });
    const current = await readSavIntakeCurrent(threadId, config);
    expect(counts.model).toBe(1);
    expect(counts.other).toBe(0);
    expect(current?.payload.plan?.decision.classification).toBe("support");
    expect(JSON.stringify(current?.payload.plan?.decision)).not.toContain("cancellation");
    expect(await f.db.select().from(savActions)).toHaveLength(0);
  });

  // ~60k characters, below the 100k storage bound: a request the model can read in one call.
  const oversized = () => Array.from({ length: 1_000 }, (_, i) => `Ligne ${i} : l'été dernier, la synchronisation échouée a été réessayée.`).join("\n");
  it("[INV] C11 a long current request reaches the model complete, never refused on size nor truncated", async () => {
    const body = oversized();
    expect(body.length).toBeLessThan(100_000);
    const m = await stored(body), id = await enqueueSavIntakeMessage(m.id, config), { counts, network } = provider(m.id);
    const sent: string[] = [];
    const observed = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(url).startsWith("https://generativelanguage.googleapis.com/")) sent.push(String(init?.body));
      return network(url, init);
    });
    await analyseSavIntakeRuntime(id!, config, { env: () => environment, network: observed });
    const current = await readSavIntakeCurrent(threadId, config);
    expect(counts.model).toBeGreaterThanOrEqual(1);
    expect(current?.payload.reason).not.toBe("SAV_INTAKE_MODEL_CONTEXT_LIMIT");
    expect(JSON.stringify(current?.payload.traces ?? [])).not.toContain("contextLimit");
    // The last line travels to the model: nothing was cut to fit.
    expect(sent.some(text => text.includes("Ligne 999 "))).toBe(true);
    expect(current?.payload.plan?.decision.classification).toBe("support");
  });

  it("[INV] C12 a code/config correction never resets attempts: one more bounded try, then a visible block", async () => {
    const m = await stored(CURRENT);
    const failTwice = async (runId: string, c: IntakeRuntimeConfig) => {
      for (let n = 0; n < 2; n++) {
        await f.db.update(savIntakeRuns).set({ leaseUntil: null, state: "waiting" }).where(eq(savIntakeRuns.id, runId));
        const lease = (await claimSavIntakeRun(runId, c))!;
        expect(lease).toBeTruthy();
        await failSavIntakeRun(lease, { revision: "x", effects: "not_connected", reason: "SAV_INTAKE_MODEL_CONTEXT_LIMIT" } as never);
      }
    };
    const first = (await enqueueSavIntakeMessage(m.id, config))!;
    await failTwice(first, config);
    // A correction deployment may retry a failing dossier once (failed 2 < 4)...
    const corrected = savIntakeRuntimeConfig(env(mailboxId, "b".repeat(40)))!;
    expect(corrected.configHash).not.toBe(config.configHash);
    const second = (await enqueueSavIntakeMessage(m.id, corrected))!;
    expect(second).not.toBe(first);
    await failTwice(second, corrected);
    // ...but never beyond the lifetime cap of failed attempts, whatever the deployment.
    const again = savIntakeRuntimeConfig(env(mailboxId, "c".repeat(40)))!;
    const third = (await enqueueSavIntakeMessage(m.id, again))!;
    expect(await claimSavIntakeRun(third, again)).toBeNull();
    expect(await pendingSavIntakeRuns(again)).toEqual([]);
    const runs = await f.db.select().from(savIntakeRuns).where(eq(savIntakeRuns.messageId, m.id));
    expect(runs.reduce((sum, run) => sum + run.attempts, 0)).toBe(SAV_INTAKE_ATTEMPT_POLICY.failedPerMessage);
    const markers = await f.db.select().from(savIntakeJournal).where(eq(savIntakeJournal.runId, third));
    expect(markers.filter(j => j.kind === "attempts_exhausted")).toHaveLength(1);
    expect(await f.db.select().from(savIntakeModelCalls)).toHaveLength(0);
  });
});
