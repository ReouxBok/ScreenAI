import { expect, it } from "vitest";
import { savIntakeMutationSchema } from "./contract";
import { executionPolicySchema } from "./execution-policy";
import { intakeRuntimeHash } from "./runtime-contract";

const legacyMutations = ["create_ticket", "link_ticket", "set_ticket_new", "append_ticket_note", "associate_email", "send_identity_template",
  "assign_v2_owner", "create_ticket_v2_owner", "send_case_reply"];
const legacyPolicy = {
  revision: "sav-intake-execution-2026-10-21.v1", mailboxId: "10000000-0000-4000-8000-000000000001", codeRevision: "a".repeat(40),
  enginePolicyHash: "b".repeat(64), resourcesHash: "c".repeat(64), receivedAfter: "2026-11-01T00:00:00.000Z",
  createdAfter: "2026-11-02T00:00:00.000Z", expiresAt: "2026-11-03T00:00:00.000Z", maxDossiers: 7,
  mutations: legacyMutations, admission: { kind: "automatic" },
};
// Frozen before widening the bound: schema field order, optional fields and mutation order are hash-sensitive.
const legacyHashes = [
  "4aa7f8c9c4b9a6c343b0a9c4225886ad3ef23f47dda9e14eeb0645b3ac16a50b",
  "226368cb0031a4ab62453cd222793980b90c23d3c582c0ce8596feffbce1333f",
  "e734d4ed985057cc34408e7230bf1581d4a165ef4387a64ebbc08f41bc128873",
  "bd7d50f205cafdd5c0a1170677ac67f90d6d76e68e97db1f9b74dbcf76366c2a",
  "fe72693a73a35ea54e51f237087432672c198fb6144b337722ac702eb540b33e",
  "55ab4017affb0f941eb23352a5de24de1152a3f5bf393124dde3f001478b078c",
  "fbbd1a407fb06c68f2cc12c2f4dc1296715f85aca590f7849f5200ae3bcb7f8a",
  "6ea20446e480f6e2de612b642d01fb53090b54d756e5c7f0c5ac48fccad6f0b0",
  "5391bdbaf31459d4d9cb509d5a09f7a385706167e8a836ae31a8314942fcc244",
];

it("accepts all 13 execution rights (SAV-95: close_acknowledged_ticket) without changing their order or granting additional rights", () => {
  expect(savIntakeMutationSchema.options).toHaveLength(13);
  const policy = { ...legacyPolicy, mutations: [...savIntakeMutationSchema.options].reverse() };
  expect(executionPolicySchema.parse(policy)).toEqual(policy);
});

it("refuses a duplicate even below the bound", () => {
  expect(executionPolicySchema.safeParse({ ...legacyPolicy, mutations: ["create_ticket", "create_ticket"] }).success).toBe(false);
});

it("refuses an unknown right even below the bound", () => {
  expect(executionPolicySchema.safeParse({ ...legacyPolicy, mutations: ["unknown_right"] }).success).toBe(false);
});

it.each(legacyHashes.map((hash, index) => ({ count: index + 1, hash })))("keeps the existing $count-right policy and its exact hash", ({ count, hash }) => {
  const policy = { ...legacyPolicy, mutations: legacyMutations.slice(0, count) };
  const parsed = executionPolicySchema.parse(policy);
  expect(JSON.stringify(parsed)).toBe(JSON.stringify(policy));
  expect(intakeRuntimeHash(parsed)).toBe(hash);
});
