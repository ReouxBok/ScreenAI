import { afterEach, it, expect, vi } from "vitest";
const s = vi.hoisted(() => ({ user: null as unknown }));
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => s.user }));
import { evaluationAdministrator } from "./server-auth";
afterEach(() => { s.user = null; vi.unstubAllEnvs(); });
const user = (email: string, status = "verified") => ({ id: "synthetic", primaryEmailAddress: { emailAddress: email, verification: { status } } });
it("permits a verified administrator without staff persistence", async () => { s.user = user("ugo@limova.ai"); expect(await evaluationAdministrator()).toBe("ugo@limova.ai"); });
it.each([null, user("contact@limova.ai"), user("outsider@example.invalid"), user("ugo@limova.ai", "unverified")])("rejects missing/invalid administrator", async value => { s.user = value; await expect(evaluationAdministrator()).rejects.toThrow("SAV_EVAL_UNAUTHORIZED"); });
it("does not accept a development bypass without Clerk identity", async () => { vi.stubEnv("DEV_AUTH_BYPASS", "true"); vi.stubEnv("DEV_USER_EMAIL", "ugo@limova.ai"); await expect(evaluationAdministrator()).rejects.toThrow(); });
