import "server-only";
import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { savCases, savMessages, savSyncState } from "@/db/schema";

/*
 * SAV-80: the qualification scope of V2. One private, strictly parsed configuration narrows EVERY V2 action to one real test exchange:
 * the exact stored sender, the exact CRM primary contact, the exact initial subject, a short unexpired window, and ONE thread, the first
 * admissible one, bound atomically. Read at the boundaries that already exist (owner at creation, relay attribution, customer return,
 * continuation, effect dispatch); it adds no admission reason, no migration and no UI. It never reads a mail's text: a quoted or forwarded
 * address is not a sender. Absent mode AND absent scope: today's behaviour, unchanged. A scope without the mode, any other mode value, or a
 * missing, invalid, not yet open or expired scope in qualification mode: nothing is allowed, never a permissive fallback. The binding holds
 * the hash of the exact configuration: any change of contact, sender, subject or window under the same revision refuses, it never
 * reinterprets an older thread. No value lives in code: root sets the configuration. SAV-81: a mail V1 already confirmed on the ticket it
 * created can bind through the relay too, only with the same checks, V1's proofs and a fresh V2 owner reading (see `v2EntryRelayDeps`).
 */

type Env = Readonly<Record<string, string | undefined>>;
export const SAV_V2_SCOPE_MODE_ENV = "SAV_V2_SCOPE_MODE";
export const SAV_V2_QUALIFICATION_SCOPE_ENV = "SAV_V2_QUALIFICATION_SCOPE_JSON";
export const SAV_V2_QUALIFICATION_SCOPE_SCHEMA = "sav-v2-qualification-scope.v1";
const BINDING_PREFIX = "sav-v2-qualification-thread.v1";
const MAX_WINDOW_MS = 7 * 24 * 3600_000;

const iso = z.string().max(40).refine(value => /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)), "ISO_DATE");
const scopeSchema = z.object({
  schema: z.literal(SAV_V2_QUALIFICATION_SCOPE_SCHEMA),
  revision: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/),
  // As stored by the ingestion (`normalizeEmailAddress`): lower case, no display name, no spaces. Compared exactly, never rewritten.
  senderEmail: z.string().max(254).regex(/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/),
  hubspotContactId: z.string().regex(/^[0-9]{1,20}$/),
  // Exact, as written: surrounding spaces are refused, not trimmed.
  initialSubject: z.string().min(1).max(200).regex(/^\S(?:.*\S)?$/),
  notBefore: iso,
  expiresAt: iso,
}).strict().refine(value => Date.parse(value.expiresAt) > Date.parse(value.notBefore) && Date.parse(value.expiresAt) - Date.parse(value.notBefore) <= MAX_WINDOW_MS, "WINDOW");

export type SavV2QualificationScope = z.infer<typeof scopeSchema>;
export type SavV2ScopeProblem = "scope_mode_missing" | "scope_mode_invalid" | "scope_missing" | "scope_invalid" | "scope_not_open" | "scope_expired";
export type SavV2ScopeRead =
  | Readonly<{ mode: "open" }>
  | Readonly<{ mode: "qualification"; scope: SavV2QualificationScope; configHash: string }>
  | Readonly<{ mode: "closed"; problem: SavV2ScopeProblem }>;

/** The scope in force now. `open`: no qualification mode (today's behaviour). `closed`: nothing V2 may act on. */
export function readSavV2QualificationScope(env: Env, now: Date = new Date()): SavV2ScopeRead {
  const mode = env[SAV_V2_SCOPE_MODE_ENV], raw = env[SAV_V2_QUALIFICATION_SCOPE_ENV];
  if (mode === undefined || mode === "") return raw ? { mode: "closed", problem: "scope_mode_missing" } : { mode: "open" };
  if (mode !== "qualification") return { mode: "closed", problem: "scope_mode_invalid" };
  if (!raw) return { mode: "closed", problem: "scope_missing" };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { mode: "closed", problem: "scope_invalid" }; }
  const parsed = scopeSchema.safeParse(value);
  if (!parsed.success) return { mode: "closed", problem: "scope_invalid" };
  if (now.getTime() < Date.parse(parsed.data.notBefore)) return { mode: "closed", problem: "scope_not_open" };
  if (now.getTime() >= Date.parse(parsed.data.expiresAt)) return { mode: "closed", problem: "scope_expired" };
  return { mode: "qualification", scope: parsed.data, configHash: savV2QualificationScopeHash(parsed.data) };
}

/** The exact configuration, every field in a fixed order: what a binding is bound to. */
export function savV2QualificationScopeHash(scope: SavV2QualificationScope) {
  const { schema, revision, senderEmail, hubspotContactId, initialSubject, notBefore, expiresAt } = scope;
  return createHash("sha256").update(JSON.stringify([schema, revision, senderEmail, hubspotContactId, initialSubject, notBefore, expiresAt])).digest("hex");
}

export type SavV2ScopeDecision = Readonly<{ allowed: true }> | Readonly<{ allowed: false; reason: string }>;
const ALLOWED: SavV2ScopeDecision = { allowed: true };
const refuse = (reason: string): SavV2ScopeDecision => ({ allowed: false, reason });
const bindingKey = (scope: SavV2QualificationScope) => `${BINDING_PREFIX}:${scope.revision}`;

type Db = Pick<ReturnType<typeof requireDb>, "select" | "insert">;
type Binding = { threadId: string; messageId: string; configHash: string; boundAt: string };

/** The thread bound to this scope revision, or null. A row that cannot be read as a binding is no binding (and binds nothing else). */
async function readBinding(db: Db, scope: SavV2QualificationScope): Promise<Binding | "unreadable" | null> {
  const [row] = await db.select({ cursor: savSyncState.cursor }).from(savSyncState).where(eq(savSyncState.key, bindingKey(scope)));
  if (!row) return null;
  try {
    const value = JSON.parse(row.cursor ?? "") as Partial<Binding>;
    return typeof value.threadId === "string" && typeof value.messageId === "string" && typeof value.configHash === "string" ? value as Binding : "unreadable";
  } catch { return "unreadable"; }
}

/** Is this stored message the FIRST message of its thread, inbound, from the exact sender, with the exact subject, inside the window? */
async function firstAdmissibleMessage(db: Db, scope: SavV2QualificationScope, messageId: string): Promise<SavV2ScopeDecision & { threadId?: string }> {
  const [message] = await db.select({ id: savMessages.id, threadId: savMessages.threadId, direction: savMessages.direction, fromEmail: savMessages.fromEmail,
    subject: savMessages.subject, receivedAt: savMessages.receivedAt }).from(savMessages).where(eq(savMessages.id, messageId));
  if (!message) return refuse("qualification_message_missing");
  if (message.direction !== "inbound" || message.fromEmail !== scope.senderEmail) return refuse("qualification_sender_mismatch");
  if (message.subject !== scope.initialSubject) return refuse("qualification_subject_mismatch");
  const at = message.receivedAt.getTime();
  if (at < Date.parse(scope.notBefore) || at >= Date.parse(scope.expiresAt)) return refuse("qualification_outside_window");
  // An older exchange answered under the same subject is not a new test thread: the bound message must open its thread.
  const [first] = await db.select({ id: savMessages.id }).from(savMessages).where(eq(savMessages.threadId, message.threadId))
    .orderBy(asc(savMessages.receivedAt), asc(savMessages.createdAt), asc(savMessages.id)).limit(1);
  if (first?.id !== message.id) return refuse("qualification_not_first_message");
  return { allowed: true, threadId: message.threadId };
}

/**
 * Owner at creation: V1 is about to create the ticket for this message with this primary contact. SAV-81: also the relay of a mail V1
 * already confirmed on the ticket it created, once an operator put that ticket under the V2 owner (`v2EntryRelayDeps`); these two are
 * the only binders. In qualification mode the message must open an admissible thread for the exact contact; the first such thread is
 * bound atomically (`insert … on conflict do nothing`, then read back), and any other thread is refused for this scope revision.
 */
export async function bindSavV2QualificationThread(env: Env, input: Readonly<{ messageId: string; primaryContactId: string | null | undefined }>, now: Date = new Date(), given?: Db): Promise<SavV2ScopeDecision> {
  return checkOrBind(env, input, now, given, true);
}

/** SAV-81: the same checks as the binding, read only: would this message bind (or is its thread already the bound one)? Nothing is written. */
export async function previewSavV2QualificationThread(env: Env, input: Readonly<{ messageId: string; primaryContactId: string | null | undefined }>, now: Date = new Date(), given?: Db): Promise<SavV2ScopeDecision> {
  return checkOrBind(env, input, now, given, false);
}

async function checkOrBind(env: Env, input: Readonly<{ messageId: string; primaryContactId: string | null | undefined }>, now: Date, given: Db | undefined, write: boolean): Promise<SavV2ScopeDecision> {
  const read = readSavV2QualificationScope(env, now);
  if (read.mode === "open") return ALLOWED;
  if (read.mode === "closed") return refuse(`qualification_${read.problem}`);
  // The database is reached only for a real qualification read: the open mode (today) and a closed scope never touch it.
  const db = given ?? requireDb();
  const scope = read.scope;
  // A binding made under another configuration of this revision is never reinterpreted, before any new binding is considered.
  const existing = await readBinding(db, scope);
  if (existing === "unreadable") return refuse("qualification_binding_unreadable");
  if (existing && existing.configHash !== read.configHash) return refuse("qualification_scope_changed");
  if (input.primaryContactId !== scope.hubspotContactId) return refuse("qualification_contact_mismatch");
  const admissible = await firstAdmissibleMessage(db, scope, input.messageId);
  if (!admissible.allowed) return admissible;
  if (!write) return existing && existing.threadId !== admissible.threadId ? refuse("qualification_other_thread_bound") : ALLOWED;
  const cursor: Binding = { threadId: admissible.threadId!, messageId: input.messageId, configHash: read.configHash, boundAt: now.toISOString() };
  await db.insert(savSyncState).values({ key: bindingKey(scope), status: "bound", cursor: JSON.stringify(cursor) }).onConflictDoNothing();
  const bound = await readBinding(db, scope);
  if (bound === null || bound === "unreadable") return refuse("qualification_binding_unreadable");
  if (bound.configHash !== read.configHash) return refuse("qualification_scope_changed");
  return bound.threadId === admissible.threadId ? ALLOWED : refuse("qualification_other_thread_bound");
}

/** A stored message V2 would act on (a relay attribution, a customer return): it must be on the bound thread and from the exact sender. */
export async function savV2QualificationMessageAllowed(env: Env, messageId: string, now: Date = new Date(), given?: Db): Promise<SavV2ScopeDecision> {
  const read = readSavV2QualificationScope(env, now);
  if (read.mode === "open") return ALLOWED;
  if (read.mode === "closed") return refuse(`qualification_${read.problem}`);
  // The database is reached only for a real qualification read: the open mode (today) and a closed scope never touch it.
  const db = given ?? requireDb();
  const bound = await readBinding(db, read.scope);
  if (bound === null) return refuse("qualification_thread_unbound");
  if (bound === "unreadable") return refuse("qualification_binding_unreadable");
  if (bound.configHash !== read.configHash) return refuse("qualification_scope_changed");
  const [message] = await db.select({ threadId: savMessages.threadId, direction: savMessages.direction, fromEmail: savMessages.fromEmail }).from(savMessages).where(eq(savMessages.id, messageId));
  if (!message) return refuse("qualification_message_missing");
  if (message.threadId !== bound.threadId) return refuse("qualification_other_thread");
  if (message.direction !== "inbound" || message.fromEmail !== read.scope.senderEmail) return refuse("qualification_sender_mismatch");
  return ALLOWED;
}

/** A case V2 would investigate or act for: its threads must be exactly the bound thread, nothing more. */
export async function savV2QualificationCaseAllowed(env: Env, caseId: string, now: Date = new Date(), given?: Db): Promise<SavV2ScopeDecision> {
  const read = readSavV2QualificationScope(env, now);
  if (read.mode === "open") return ALLOWED;
  if (read.mode === "closed") return refuse(`qualification_${read.problem}`);
  // The database is reached only for a real qualification read: the open mode (today) and a closed scope never touch it.
  const db = given ?? requireDb();
  const bound = await readBinding(db, read.scope);
  if (bound === null) return refuse("qualification_thread_unbound");
  if (bound === "unreadable") return refuse("qualification_binding_unreadable");
  if (bound.configHash !== read.configHash) return refuse("qualification_scope_changed");
  const [row] = await db.select({ threadIds: savCases.threadIds }).from(savCases).where(and(eq(savCases.id, caseId)));
  if (!row) return refuse("qualification_case_missing");
  return row.threadIds.length === 1 && row.threadIds[0] === bound.threadId ? ALLOWED : refuse("qualification_other_thread");
}
