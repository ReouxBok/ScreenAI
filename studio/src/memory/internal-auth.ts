import "server-only";

import { timingSafeEqual } from "node:crypto";

export function authorizedMemoryRequest(request: Request) {
  const expected = process.env.MEMORY_SERVICE_TOKEN;
  const provided = request.headers.get("authorization");
  if (!expected || expected.length < 32 || !provided) return false;
  const expectedBuffer = Buffer.from(`Bearer ${expected}`);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}

export function validUserKey(value: unknown): value is string {
  return typeof value === "string" && /^v1:[A-Za-z0-9_-]{40,100}$/.test(value);
}
