import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/db", () => ({ requireDb: () => { throw Error("NO_DATABASE_ALLOWED"); } }));
import { closingHandoffReplyEnabled, isTerminalReply } from "./case-terminal-reply";
import {
  autoBlockProblem, caseBlockAdmittedOtherThanAccess, caseBlockReplyKernelProblem, readAutoReplyConfig, savAutoReplyLegacyAccessOnly, type SavAutoOpenBlock,
} from "./block-auto-reply";
import { decideAccessAutoApproval, decideAutoApproval, readAccessAutoApprovalConfig, type AccessAutoApprovalFacts } from "./customer-return";
import { savBlockEffectiveMode } from "./block-switch";

/*
 * 19/11: the allow-list of blocks for the automatic reply (`block-auto-reply.ts`). Synthetic values only.
 * The reference functions below are the code of `customer-return.ts` BEFORE the allow-list, copied verbatim: with `SAV_V2_AUTO_REPLY=access`
 * the new code must answer exactly what they answered, reason codes included (test of non-regression n°1 of the spec).
 */
const APPROVER = "30000000-0000-4000-8000-0000000000aa";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Env = Readonly<Record<string, string | undefined>>;
type OldConfig = Readonly<{ mode: "off"; why: "disabled" | "approver_invalid" }> | Readonly<{ mode: "on"; approverId: string }>;
function oldReadConfig(env: Env): OldConfig {
  if (env.SAV_V2_AUTO_REPLY !== "access") return { mode: "off", why: "disabled" };
  const approverId = env.SAV_V2_AUTO_APPROVER_ID ?? "";
  return UUID.test(approverId) ? { mode: "on", approverId: approverId.toLowerCase() } : { mode: "off", why: "approver_invalid" };
}
function oldDecide(input: Readonly<{ config: OldConfig; action: string; approverId: string; purpose: string; env?: Env; facts: AccessAutoApprovalFacts | null }>) {
  const { config, facts } = input;
  if (config.mode !== "on") return { allowed: false, reason: `auto_${config.why}` };
  if (input.action !== "approve") return { allowed: false, reason: "action_not_auto" };
  if (input.approverId.toLowerCase() !== config.approverId) return { allowed: false, reason: "approver_not_rule" };
  const terminal = closingHandoffReplyEnabled(input.env ?? {}) && isTerminalReply(input.purpose);
  if (!["answer", "question", "reminder"].includes(input.purpose) && !terminal) return { allowed: false, reason: "purpose_not_auto" };
  if (!facts) return { allowed: false, reason: "facts_unread" };
  if (facts.case.owner !== "agent" || !facts.case.admitted) return { allowed: false, reason: "case_not_admitted" };
  if (facts.case.sensitivity !== "none") return { allowed: false, reason: "sensitive" };
  if (!facts.openFamilies.length || facts.openFamilies.some(family => family !== "access")) return { allowed: false, reason: "not_access_only" };
  if (input.purpose !== "reminder") {
    if (!facts.decision?.accepted) return { allowed: false, reason: "decision_not_accepted" };
    const matches = terminal ? facts.decision.nextAction === (input.purpose === "closing" ? "confirm_resolution" : "handoff") : ["answer", "ask"].includes(facts.decision.nextAction);
    if (!matches) return { allowed: false, reason: "decision_not_reply" };
    if (!facts.decision.scopeCurrent) return { allowed: false, reason: "scope_not_current" };
    if (!facts.decision.shownSourcesVerified) return { allowed: false, reason: "sources_unverified" };
  }
  if (facts.ownerNow !== "v2") return { allowed: false, reason: facts.ownerNow === "unknown" ? "owner_unread" : "owner_not_v2" };
  return { allowed: true, basis: "auto_access.v1" };
}

/** `approver` given explicitly (even `undefined`) replaces the rule approver. */
const env = (value: string | undefined, ...approver: [string | undefined] | []): Env => ({ SAV_V2_AUTO_REPLY: value, SAV_V2_AUTO_APPROVER_ID: approver.length ? approver[0] : APPROVER });
const BASE: AccessAutoApprovalFacts = { case: { owner: "agent", sensitivity: "none", admitted: true }, openFamilies: ["access"], ownerNow: "v2",
  decision: { accepted: true, scopeCurrent: true, shownSourcesVerified: true, nextAction: "answer" } };
/** A broad matrix of facts: each field moved away from the allowed case, alone. */
const FACTS: Array<AccessAutoApprovalFacts | null> = [null, BASE,
  { ...BASE, case: { ...BASE.case, owner: "human" } }, { ...BASE, case: { ...BASE.case, admitted: false } }, { ...BASE, case: { ...BASE.case, sensitivity: "finance" } },
  { ...BASE, openFamilies: [] }, { ...BASE, openFamilies: ["usage"] }, { ...BASE, openFamilies: ["access", "usage"] }, { ...BASE, openFamilies: ["integration"] },
  { ...BASE, decision: null }, { ...BASE, decision: { ...BASE.decision!, accepted: false } }, { ...BASE, decision: { ...BASE.decision!, nextAction: "handoff" } },
  { ...BASE, decision: { ...BASE.decision!, nextAction: "confirm_resolution" } }, { ...BASE, decision: { ...BASE.decision!, nextAction: "ask" } },
  { ...BASE, decision: { ...BASE.decision!, scopeCurrent: false } }, { ...BASE, decision: { ...BASE.decision!, shownSourcesVerified: false } },
  { ...BASE, ownerNow: "human" }, { ...BASE, ownerNow: "unknown" }, { ...BASE, ownerNow: "none" }];
const PURPOSES = ["answer", "question", "reminder", "closing", "handoff", "other"];
/** The block of each open request as the passage reads it: `access` for the family `access`, a synthetic block for the others. */
const withBlocks = (facts: AccessAutoApprovalFacts | null): AccessAutoApprovalFacts | null => facts && ({ ...facts,
  openBlocks: facts.openFamilies.map(family => ({ family, blockId: family === "access" ? "access" : "syn-widget" })) });

afterEach(() => vi.restoreAllMocks());

describe("reading the allow-list (`SAV_V2_AUTO_REPLY`)", () => {
  it("`access` is today's value, read as the list [access] with the rule approver; the legacy reading", () => {
    const config = readAutoReplyConfig(env("access"));
    expect(config).toMatchObject({ mode: "on", approverId: APPROVER });
    expect([...config.blocks]).toEqual(["access"]);
    expect([...config.pairs]).toEqual([]);
    expect(savAutoReplyLegacyAccessOnly(config)).toBe(true);
  });
  it("several blocks, spaces around commas and duplicates; a qualified pair is canonical (sorted) and needs both blocks listed", () => {
    const config = readAutoReplyConfig(env(" access , syn-widget,access,syn-widget+access , syn-other+access"));
    expect([...config.blocks].sort()).toEqual(["access", "syn-widget"]);
    expect([...config.pairs]).toEqual(["access+syn-widget"]);
    expect(config.ignored).toEqual(["syn-other+access"]);
    expect(savAutoReplyLegacyAccessOnly(config)).toBe(false);
  });
  it("the three new blocks' ids (INTERFACE.md: collaborators, charly_max, integrations) and their pairs with Access are read", () => {
    const config = readAutoReplyConfig(env("access,collaborators,charly_max,integrations,access+charly_max"));
    expect([...config.blocks].sort()).toEqual(["access", "charly_max", "collaborators", "integrations"]);
    expect([...config.pairs]).toEqual(["access+charly_max"]);
    expect(config.ignored).toEqual([]);
  });
  it("never a joker: `*`, `all`, capitals, other characters, a self pair are ignored and logged; an empty list is off", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const value of ["*", "all", "ALL", "ACCESS", "Access", "access;usage", "acc ess", "a", "access+access", "tous", "", " , ", "x".repeat(41)]) {
      const config = readAutoReplyConfig(env(value));
      expect([value, config.mode, config.blocks.size]).toEqual([value, "off", 0]);
    }
    const mixed = readAutoReplyConfig(env("access,*,all,Syn"));
    expect([...mixed.blocks]).toEqual(["access"]);
    expect(mixed.ignored).toEqual(["*", "all", "Syn"]);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain("never a joker");
  });
  it("absent, or no valid rule approver (never a person's id): off, exactly as before", () => {
    expect(readAutoReplyConfig({})).toMatchObject({ mode: "off", why: "disabled" });
    expect(readAutoReplyConfig(env("access", undefined))).toMatchObject({ mode: "off", why: "approver_invalid" });
    expect(readAutoReplyConfig(env("access,syn-widget", "ugo"))).toMatchObject({ mode: "off", why: "approver_invalid" });
  });
  it("Access's own view keeps the former shape: on only when `access` is listed; identical to the former reading for every former value", () => {
    for (const value of [undefined, "", "access", "all", "*", "ACCESS", "syn-widget", "usage", "none"])
      for (const approver of [undefined, "", APPROVER, APPROVER.toUpperCase(), "ugo", "30000000-0000-4000-8000-00000000000"])
        expect([value, approver, readAccessAutoApprovalConfig(env(value, approver))]).toEqual([value, approver, oldReadConfig(env(value, approver))]);
    expect(readAccessAutoApprovalConfig(env("syn-widget,access"))).toEqual({ mode: "on", approverId: APPROVER });
    expect(readAccessAutoApprovalConfig(env("syn-widget"))).toEqual({ mode: "off", why: "disabled" });
  });
});

describe("the single block rule (`autoBlockProblem`)", () => {
  const config = (value: string) => readAutoReplyConfig(env(value));
  const rows = (...pairs: Array<[string, string | null]>): SavAutoOpenBlock[] => pairs.map(([family, blockId]) => ({ family, blockId }));
  it("legacy list: the former family test and its code, whatever the blocks say", () => {
    expect(autoBlockProblem({ openFamilies: ["access"] }, config("access"))).toBeNull();
    expect(autoBlockProblem({ openFamilies: ["usage"], openBlocks: rows(["usage", "access"]) }, config("access"))).toBe("not_access_only");
    expect(autoBlockProblem({ openFamilies: [] }, config("access"))).toBe("not_access_only");
  });
  it("one listed block: allowed; a block not listed: `block_not_allowed`; no block recorded: `block_unknown`", () => {
    const list = config("access,syn-widget");
    expect(autoBlockProblem({ openFamilies: ["usage"], openBlocks: rows(["usage", "syn-widget"]) }, list)).toBeNull();
    expect(autoBlockProblem({ openFamilies: ["access"], openBlocks: rows(["access", "access"]) }, list)).toBeNull();
    expect(autoBlockProblem({ openFamilies: ["usage"], openBlocks: rows(["usage", "syn-other"]) }, list)).toBe("block_not_allowed");
    expect(autoBlockProblem({ openFamilies: ["usage"], openBlocks: rows(["usage", null]) }, list)).toBe("block_unknown");
    expect(autoBlockProblem({ openFamilies: ["usage"] }, list)).toBe("block_unknown");
    expect(autoBlockProblem({ openFamilies: [], openBlocks: [] }, list)).toBe("block_unknown");
  });
  it("the family `access` is the Access block's alone, both ways: a mis-recorded block is unknown, never trusted", () => {
    const list = config("access,syn-widget");
    expect(autoBlockProblem({ openFamilies: ["access"], openBlocks: rows(["access", "syn-widget"]) }, list)).toBe("block_unknown");
    expect(autoBlockProblem({ openFamilies: ["usage"], openBlocks: rows(["usage", "access"]) }, list)).toBe("block_unknown");
  });
  it("several blocks stay a draft for a person until their pair is qualified; never more than two", () => {
    const both = rows(["access", "access"], ["usage", "syn-widget"]);
    expect(autoBlockProblem({ openFamilies: ["access", "usage"], openBlocks: both }, config("access,syn-widget"))).toBe("multi_block_draft");
    expect(autoBlockProblem({ openFamilies: ["access", "usage"], openBlocks: both }, config("access,syn-widget,syn-widget+access"))).toBeNull();
    const three = [...both, ...rows(["integration", "syn-int"])];
    expect(autoBlockProblem({ openFamilies: ["access", "usage", "integration"], openBlocks: three }, config("access,syn-widget,syn-int,access+syn-widget,access+syn-int,syn-int+syn-widget"))).toBe("multi_block_draft");
    expect(autoBlockProblem({ openFamilies: ["access", "usage"], openBlocks: both }, config("syn-widget,access+syn-widget"))).toBe("block_not_allowed");
  });
});

describe("A's approval on the allow-list (`decideAutoApproval`)", () => {
  it("with `SAV_V2_AUTO_REPLY=access`: exactly the former Access rule on every fact, purpose and approver (byte for byte)", () => {
    const configs = [env("access"), env("access", "bad"), env(undefined), env("all")];
    for (const e of configs) for (const facts of FACTS) for (const purpose of PURPOSES) for (const terminal of [{}, { SAV_V2_CLOSING_HANDOFF_REPLY: "on" }])
      for (const approverId of [APPROVER, APPROVER.toUpperCase(), "30000000-0000-4000-8000-0000000000bb"]) for (const action of ["approve", "revoke"]) {
        const input = { action, approverId, purpose, env: terminal, facts };
        const expected = oldDecide({ ...input, config: oldReadConfig(e) });
        expect(decideAutoApproval({ ...input, config: readAutoReplyConfig(e) })).toEqual(expected);
        expect(decideAccessAutoApproval({ ...input, config: readAccessAutoApprovalConfig(e) })).toEqual(expected);
      }
  });
  it("with a longer list that keeps Access: an Access-only case decides as before; another listed block now passes; a mixed case stays a draft", () => {
    const longer = readAutoReplyConfig(env("access,syn-widget"));
    for (const facts of FACTS.filter(row => row?.openFamilies.length === 1 && row.openFamilies[0] === "access")) for (const purpose of PURPOSES) {
      const input = { action: "approve", approverId: APPROVER, purpose, facts: withBlocks(facts) };
      expect(decideAutoApproval({ ...input, config: longer })).toEqual(oldDecide({ ...input, config: oldReadConfig(env("access")) }));
    }
    const decide = (openFamilies: string[]) => decideAutoApproval({ config: longer, action: "approve", approverId: APPROVER, purpose: "answer", facts: withBlocks({ ...BASE, openFamilies }) });
    expect(decide(["usage"])).toEqual({ allowed: true, basis: "auto_access.v1" });
    expect(decide(["access", "usage"])).toEqual({ allowed: false, reason: "multi_block_draft" });
    expect(decideAutoApproval({ config: longer, action: "approve", approverId: APPROVER, purpose: "answer", facts: { ...BASE, openFamilies: ["usage"] } }))
      .toEqual({ allowed: false, reason: "block_unknown" });
  });
  it("a list without Access: an Access case is not approved (`block_not_allowed`); its every other check still applies first", () => {
    const widget = readAutoReplyConfig(env("syn-widget"));
    expect(decideAutoApproval({ config: widget, action: "approve", approverId: APPROVER, purpose: "answer", facts: withBlocks(BASE) })).toEqual({ allowed: false, reason: "block_not_allowed" });
    expect(decideAutoApproval({ config: widget, action: "approve", approverId: APPROVER, purpose: "answer", facts: withBlocks({ ...BASE, case: { ...BASE.case, sensitivity: "cancellation" } }) }))
      .toEqual({ allowed: false, reason: "sensitive" });
  });
});

describe("the effective mode a block shows (`savBlockEffectiveMode`)", () => {
  const state = (blockId: string, mode: "off" | "draft" | "auto", paused = false, invalid = false) => ({ blockId, mode, paused, invalid });
  it("listed and switched to auto: auto; switched to auto but not listed: draft (the real reason); off, paused, invalid as before", () => {
    const list = env("access,syn-widget");
    expect(savBlockEffectiveMode(state("syn-widget", "auto"), list)).toBe("auto");
    expect(savBlockEffectiveMode(state("syn-other", "auto"), list)).toBe("draft");
    expect(savBlockEffectiveMode(state("syn-widget", "draft"), list)).toBe("draft");
    expect(savBlockEffectiveMode(state("syn-widget", "off"), list)).toBe("off");
    expect(savBlockEffectiveMode(state("syn-widget", "auto", true), list)).toBe("paused");
    expect(savBlockEffectiveMode(state("syn-widget", "auto", false, true), list)).toBe("off");
  });
  it("with `access` alone nothing changes: Access auto, any other block draft at most", () => {
    expect(savBlockEffectiveMode(state("access", "auto"), env("access"))).toBe("auto");
    expect(savBlockEffectiveMode(state("syn-widget", "auto"), env("access"))).toBe("draft");
    expect(savBlockEffectiveMode(state("access", "auto"), env(undefined))).toBe("draft");
    expect(savBlockEffectiveMode(state("access", "auto"), env("syn-widget"))).toBe("draft");
  });
});

describe("« le noyau dans notre réponse » for every block other than Access", () => {
  const admission = (blockId?: string, kind = "qualified_rule") => ({ qualification: { requests: [{ requestId: "r1", family: "usage", provenance: { kind, ruleId: "rule-syn", revision: "r1", ...(blockId ? { blockId } : {}) } }] } });
  it("a case a block other than Access admitted: our answer, question or reminder with a kernel phrase is cancelled; a hand-over or closing is not judged", () => {
    for (const purpose of ["answer", "question", "reminder"])
      expect(caseBlockReplyKernelProblem({ admission: admission("syn-widget"), text: "Pour résilier votre abonnement, écrivez-nous.", purpose })).toBe("CANCELLED_REPLY_SENSITIVE_WORDING");
    for (const purpose of ["handoff", "closing"]) expect(caseBlockReplyKernelProblem({ admission: admission("syn-widget"), text: "Votre demande de remboursement est transmise.", purpose })).toBeNull();
    expect(caseBlockReplyKernelProblem({ admission: admission("syn-widget"), text: "Ouvrez le menu Réglages puis Widget.", purpose: "answer" })).toBeNull();
  });
  it("Access, a rule written before blocks, a human qualification or no admission: untouched here (Access keeps its own fence)", () => {
    for (const value of [admission("access"), admission(undefined), admission("syn-widget", "human"), null, undefined, {}]) {
      expect(caseBlockAdmittedOtherThanAccess(value)).toBe(false);
      expect(caseBlockReplyKernelProblem({ admission: value, text: "Pour résilier votre abonnement, écrivez-nous.", purpose: "answer" })).toBeNull();
    }
  });
});

describe("one place for the rule: every caller of the block decision goes through `autoBlockProblem`", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const source = (file: string) => readFileSync(path.join(dir, file), "utf8");
  it("no copy of the former Access family test is left in the seven places; the passage, the approval and J2 call the shared function", () => {
    for (const file of ["customer-return.ts", "investigation-reply-passage.ts", "block-switch.ts", "j2-auto-reminder.ts", "v2-j2-binding.ts"]) {
      expect([file, /family !== "access"\)\) reasons\.push|openFamilies\.some\(family => family !== "access"\)/.test(source(file))]).toEqual([file, false]);
      expect([file, /SAV_V2_AUTO_REPLY !== "access"/.test(source(file))]).toEqual([file, false]);
    }
    expect(source("investigation-reply-passage.ts")).toContain("autoBlockProblem(facts, config)");
    expect(source("customer-return.ts")).toContain("autoBlockProblem(facts, config)");
    expect(source("j2-auto-reminder.ts")).toContain("autoBlockProblem(");
  });
  it("the pure module imports only the case contract and the kernel phrases", () => {
    expect([...source("block-auto-reply.ts").matchAll(/from "([^"]+)"/g)].map(match => match[1]).sort()).toEqual(["./access-skill/access-skill-kernel", "./case-types"]);
  });
});
