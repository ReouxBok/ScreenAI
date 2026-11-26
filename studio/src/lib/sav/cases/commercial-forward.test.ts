import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCommercialForward, COMMERCIAL_FORWARD_MAX_ATTEMPTS, COMMERCIAL_FORWARD_MAX_ORIGINAL_BYTES, commercialForwardKey, commercialForwardRfcMessageId, forwardCommercialPart,
  SAV_COMMERCIAL_FORWARD_RECIPIENT, type CommercialForwardDeps, type CommercialForwardFacts, type CommercialForwardMetadata, type CommercialForwardStep, type CommercialForwardStore,
} from "./commercial-forward";

/*
 * Ugo 26/11: the commercial part of a mixed mail, forwarded ALONE to sales, silently. FICTIONAL data only (public repository): in-memory receipts, a fake
 * Gmail, no network. What is proven: recorded before the send, never sent twice (replay, crash between steps, unknown send outcome), only to sales.
 */

const KEY = commercialForwardKey("case-fictif", "in:e1");
const FACTS: CommercialForwardFacts = {
  asks: ["choisir l'offre adaptée à 8 Assistants et obtenir une démo"],
  source: { mailboxEmail: "contact@limova.ai", gmailMessageId: "18c0ffee", gmailThreadId: "", fromEmail: "paul@exemple.invalid", subject: "Questions de démarrage",
    receivedAt: "2026-11-26T08:00:00.000Z", text: "Comment configurer mes Assistants ? Quelle offre me conseillez-vous ?" },
};

function memoryStore(initial: CommercialForwardStep[] = ["queued"]) {
  const log: Array<{ step: CommercialForwardStep; metadata: CommercialForwardMetadata }> = initial.map(step => ({ step, metadata: {} }));
  let attempts = 0, leased = false;
  const store: CommercialForwardStore = {
    steps: async () => [...new Set(log.map(row => row.step))],
    record: async (_key, step, metadata) => { if (log.some(row => row.step === step)) return false; log.push({ step, metadata }); events.push(`record:${step}`); return true; },
    receipt: async (_key, step) => log.find(row => row.step === step)?.metadata ?? null,
    lease: async () => { if (leased) return null; leased = true; return async () => { leased = false; }; },
    attempt: async () => ++attempts,
  };
  const events: string[] = [];
  return { store, log, events, attempts: () => attempts };
}
function fakeGmail(events: string[], options: { sendThrows?: boolean; sentId?: string | null; findSent?: string | null; original?: Buffer } = {}) {
  const sent: Buffer[] = [];
  const gmail: CommercialForwardDeps["gmail"] = {
    readOriginal: async () => options.original ?? Buffer.from("From: paul@exemple.invalid\r\nSubject: Questions\r\n\r\nCorps"),
    send: async (_mailbox, raw) => { events.push("send"); sent.push(raw); if (options.sendThrows) throw Error("GMAIL_TIMEOUT"); return { id: "abc123", threadId: "t1" }; },
    sentMessageId: async () => options.sentId === undefined ? commercialForwardRfcMessageId(KEY) : options.sentId,
    findSent: async () => options.findSent ?? null,
  };
  return { gmail, sent };
}
const deps = (store: CommercialForwardStore, gmail: CommercialForwardDeps["gmail"], extra: Partial<CommercialForwardDeps> = {}): CommercialForwardDeps =>
  ({ authority: async () => undefined, readFacts: async () => FACTS, store, gmail, ...extra });

beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

describe("transfert de la partie commerciale aux commerciaux (pur, idempotent)", () => {
  it("le mail part à sacha@ depuis contact@, porte la seule question commerciale et le mail d'origine joint ; jamais à l'expéditeur", () => {
    const built = buildCommercialForward(KEY, FACTS, Buffer.from("raw-original"));
    expect(built.recipient).toBe("sacha@limova.ai");
    expect(SAV_COMMERCIAL_FORWARD_RECIPIENT).toBe("sacha@limova.ai");
    const raw = built.raw.toString("utf8");
    expect(raw).toContain("From: contact@limova.ai\r\nTo: sacha@limova.ai\r\n");
    expect(raw).toContain(`Message-ID: ${commercialForwardRfcMessageId(KEY)}`);
    expect(raw).toContain("message/rfc822");
    expect(built.text).toContain("- choisir l'offre adaptée à 8 Assistants et obtenir une démo");
    expect(built.text).toContain("sans rien lui dire de celle-ci");
    expect(() => buildCommercialForward(KEY, { ...FACTS, source: { ...FACTS.source, fromEmail: "Sacha@limova.ai" } }, null)).toThrow("SAV_COMMERCIAL_FORWARD_INVALID");
    expect(() => buildCommercialForward(KEY, { ...FACTS, source: { ...FACTS.source, mailboxEmail: "ugo@limova.ai" } }, null)).toThrow("SAV_COMMERCIAL_FORWARD_INVALID");
    expect(() => buildCommercialForward(KEY, { ...FACTS, asks: [" "] }, null)).toThrow("SAV_COMMERCIAL_FORWARD_INVALID");
    // An original too large is never a reason to drop the forward: text only.
    expect(buildCommercialForward(KEY, FACTS, Buffer.alloc(COMMERCIAL_FORWARD_MAX_ORIGINAL_BYTES + 1)).attached).toBe(false);
  });

  it("chemin nominal : « dispatched » est écrit AVANT l'envoi, puis l'accusé, puis la relecture confirme ; un seul envoi", async () => {
    const { store, events, log } = memoryStore();
    const { gmail, sent } = fakeGmail(events);
    expect(await forwardCommercialPart(KEY, deps(store, gmail))).toEqual({ final: "confirmed" });
    expect(events).toEqual(["record:dispatched", "send", "record:acked", "record:confirmed"]);
    expect(sent).toHaveLength(1);
    expect(log.find(row => row.step === "confirmed")?.metadata).toMatchObject({ gmailMessageId: "abc123", proof: "send_response_id" });
    // Replay: already done, nothing sent again.
    expect(await forwardCommercialPart(KEY, deps(store, gmail))).toEqual({ skipped: "already_done" });
    expect(sent).toHaveLength(1);
  });

  it("panne entre l'enregistrement et l'envoi (issue inconnue) : la reprise relit la boîte d'envoi et ne renvoie JAMAIS", async () => {
    const { store, events } = memoryStore();
    const first = fakeGmail(events, { sendThrows: true, findSent: null });
    expect(await forwardCommercialPart(KEY, deps(store, first.gmail))).toEqual({ retry: "SAV_COMMERCIAL_FORWARD_UNCONFIRMED" });
    // The crashed pass: dispatched recorded, no ack. The next pass finds the sent copy by our Message-ID.
    const second = fakeGmail(events, { findSent: "def456" });
    expect(await forwardCommercialPart(KEY, deps(store, second.gmail))).toEqual({ final: "confirmed" });
    expect(events.filter(event => event === "send")).toHaveLength(1);
    expect(second.sent).toHaveLength(0);
  });

  it("relecture impossible à confirmer après les tentatives bornées : « uncertain » (une personne vérifie), toujours un seul envoi", async () => {
    const { store, events } = memoryStore();
    const { gmail, sent } = fakeGmail(events, { sendThrows: true, findSent: null });
    const results = [];
    for (let pass = 0; pass < COMMERCIAL_FORWARD_MAX_ATTEMPTS; pass += 1) results.push(await forwardCommercialPart(KEY, deps(store, gmail)));
    expect(results.at(-1)).toEqual({ final: "uncertain", reason: "SAV_COMMERCIAL_FORWARD_UNCONFIRMED" });
    expect(sent).toHaveLength(1);
  });

  it("rien n'est envoyé sans file d'attente, sans autorité, ou quand une autre passe tient le bail", async () => {
    const empty = memoryStore([]);
    const a = fakeGmail(empty.events);
    expect(await forwardCommercialPart(KEY, deps(empty.store, a.gmail))).toEqual({ skipped: "not_queued" });
    const queued = memoryStore();
    const b = fakeGmail(queued.events);
    expect(await forwardCommercialPart(KEY, deps(queued.store, b.gmail, { authority: async () => { throw Error("SAV_COMMERCIAL_FORWARD_PERMISSION_MISSING"); } })))
      .toEqual({ skipped: "authority", detail: "SAV_COMMERCIAL_FORWARD_PERMISSION_MISSING" });
    const release = await queued.store.lease(KEY);
    expect(await forwardCommercialPart(KEY, deps(queued.store, b.gmail))).toEqual({ skipped: "busy" });
    await release!();
    expect([...a.sent, ...b.sent]).toHaveLength(0);
  });

  it("l'expéditeur est l'adresse des commerciaux (boucle) : « not_applied », rien envoyé", async () => {
    const { store, events } = memoryStore();
    const { gmail, sent } = fakeGmail(events);
    const result = await forwardCommercialPart(KEY, deps(store, gmail, { readFacts: async () => ({ ...FACTS, source: { ...FACTS.source, fromEmail: "sacha@limova.ai" } }) }));
    expect(result).toEqual({ final: "not_applied", reason: "SAV_COMMERCIAL_FORWARD_INVALID" });
    expect(sent).toHaveLength(0);
  });
});
