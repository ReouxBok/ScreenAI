import "server-only";
import { SAV_ATTACHMENT_LIMITS, savAttachmentReferenceSchema, type SavAttachmentMetadata, type SavAttachmentReference, type SavAttachmentInventory } from "./attachment-contract";

export type SavGmailMimePart = { partId?: string; mimeType?: string; filename?: string; headers?: Array<{ name?: string; value?: string }>; body?: { data?: string; size?: number; attachmentId?: string }; parts?: SavGmailMimePart[] };
const header = (part: SavGmailMimePart, name: string) => part.headers?.find(h => h.name?.toLowerCase() === name)?.value ?? "";
export function collectSavAttachmentInventory(part: SavGmailMimePart | undefined, owner: { mailboxEmail: string; gmailMessageId: string; gmailThreadId: string }): { attachments: SavAttachmentMetadata[]; attachmentInventory: SavAttachmentInventory } {
  const result: SavAttachmentMetadata[] = [];
  const limits = new Set<SavAttachmentInventory["limits"][number]>();
  let nodes = 0;
  let stopped = false;
  function visit(value: SavGmailMimePart | undefined, depth: number) {
    if (!value || stopped) return;
    if (depth > 20) { limits.add("depth_limit"); return; }
    if (nodes >= 500) { limits.add("node_limit"); stopped = true; return; }
    nodes++;
    if (value.filename || value.body?.attachmentId || value.mimeType?.startsWith("image/")) {
      if (result.length >= SAV_ATTACHMENT_LIMITS.references) { limits.add("reference_limit"); stopped = true; return; }
      const cid = header(value, "content-id").replace(/^<|>$/g, "").slice(0, 200) || null;
      const disposition = header(value, "content-disposition").split(";")[0].trim().toLowerCase();
      const reference = savAttachmentReferenceSchema.safeParse({ version: 1, ...owner, partId: value.partId, attachmentId: value.body?.attachmentId ?? null,
        contentId: cid, disposition: disposition === "inline" || cid ? "inline" : disposition === "attachment" ? "attachment" : "unknown" });
      result.push({ filename: (value.filename || (cid ? "Image intégrée" : "Pièce jointe")).replace(/[\r\n]/g, " ").slice(0, 500), mimeType: (value.mimeType ?? "application/octet-stream").slice(0, 200),
        size: Number.isSafeInteger(value.body?.size) && value.body!.size! >= 0 ? value.body!.size! : 0, ...(reference.success ? { reference: reference.data } : {}) });
    }
    for (const child of value.parts ?? []) { if (stopped) break; visit(child, depth + 1); }
  }
  visit(part, 0);
  return { attachments: result, attachmentInventory: { complete: limits.size === 0, limits: [...limits].sort() } };
}

/** Read a bounded JSON wire response before JSON/base64 allocation. No external error body. */
export async function readSavAttachmentJson(response: Response, maximum: number): Promise<unknown> {
  if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 403 ? "permission_denied" : response.status === 404 ? "not_found" : response.status === 429 ? "rate_limited" : "download_failed"); }
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) { await response.body?.cancel(); throw new Error("byte_limit"); }
  if (!response.body) throw new Error("download_failed");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) throw new Error("byte_limit");
      chunks.push(next.value);
    }
    try { return JSON.parse(Buffer.concat(chunks, total).toString("utf8")); }
    catch { throw new Error("download_failed"); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function decodeSavAttachmentData(body: { data?: string; size?: number }, expectedSize: number) {
  const data = body.data;
  const maximum = SAV_ATTACHMENT_LIMITS.imageBytes;
  if (expectedSize > maximum || !Number.isSafeInteger(body.size) || body.size! < 1 || body.size! > maximum || body.size !== expectedSize) throw new Error("byte_limit");
  if (typeof data !== "string" || data.length > Math.ceil(expectedSize / 3) * 4 || !/^[A-Za-z0-9_-]+={0,2}$/.test(data) || data.replace(/=+$/, "").length % 4 === 1) throw new Error("invalid_image");
  const bytes = Buffer.from(data, "base64url");
  if (bytes.length !== body.size || bytes.length !== expectedSize || bytes.length > maximum || bytes.toString("base64url") !== data.replace(/=+$/, "")) throw new Error("byte_limit");
  return bytes;
}
const manifestPartFields = Array.from({ length: 20 }).reduce<string>(fields => `partId,mimeType,headers(name,value),body(attachmentId,size),parts(${fields})`, "partId,mimeType,headers(name,value),body(attachmentId,size)");
function associatedPart(message: { id?: string; threadId?: string; payload?: SavGmailMimePart }, ref: SavAttachmentReference, expectedSize: number, mimeType?: string) {
  if (message.id !== ref.gmailMessageId || message.threadId !== ref.gmailThreadId) throw new Error("association_mismatch");
  let nodes = 0;
  let incomplete = false;
  const matches: SavGmailMimePart[] = [];
  function find(part: SavGmailMimePart | undefined, depth: number) {
    if (!part) return;
    if (++nodes > 500 || depth > 20) { incomplete = true; return; }
    if (part.partId === ref.partId) matches.push(part);
    for (const child of part.parts ?? []) find(child, depth + 1);
  }
  find(message.payload, 0);
  const part = matches[0];
  if (incomplete || matches.length !== 1 || !part || (header(part, "content-id").replace(/^<|>$/g, "") || null) !== ref.contentId
    || mimeType && part.mimeType?.toLowerCase() !== mimeType.toLowerCase()) throw new Error("association_mismatch");
  if (part.body?.size !== expectedSize) throw new Error("byte_limit");
  const disposition = header(part, "content-disposition").split(";")[0].trim().toLowerCase();
  const actualDisposition = disposition === "inline" || ref.contentId ? "inline" : disposition === "attachment" ? "attachment" : "unknown";
  if (actualDisposition !== "unknown" && ref.disposition !== "unknown" && ref.disposition !== actualDisposition) throw new Error("association_mismatch");
  return part;
}
export async function fetchSavAttachmentBytes(reference: SavAttachmentReference, expectedSize: number, read: (path: string, maximum: number, signal: AbortSignal) => Promise<unknown>, signal: AbortSignal, mimeType?: string) {
  const ref = savAttachmentReferenceSchema.parse(reference);
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > SAV_ATTACHMENT_LIMITS.imageBytes) throw new Error("byte_limit");
  const base = `messages/${encodeURIComponent(ref.gmailMessageId)}`;
  // Revalidate the actual message/part/attachment binding before fetching any media.
  // Excluding body.data makes this manifest independently bounded and reusable for CID parts.
  const manifest = await read(`${base}?format=full&fields=id,threadId,payload(${manifestPartFields})`, 1024 * 1024, signal) as { id?: string; threadId?: string; payload?: SavGmailMimePart };
  const freshPart = associatedPart(manifest, ref, expectedSize, mimeType);
  // Gmail download tokens are transport references, not stable part identities.
  // Resolve the token only from the newly verified message/part/CID/type/size.
  if (freshPart.body?.attachmentId) return decodeSavAttachmentData(await read(`${base}/attachments/${encodeURIComponent(freshPart.body.attachmentId)}`, Math.ceil(expectedSize / 3) * 4 + 2048, signal) as { data?: string; size?: number }, expectedSize);
  const message = await read(`${base}?format=full&fields=id,threadId,payload`, Math.ceil(SAV_ATTACHMENT_LIMITS.totalBytes / 3) * 4 + 1024 * 1024, signal) as { id?: string; threadId?: string; payload?: SavGmailMimePart };
  const part = associatedPart(message, ref, expectedSize, mimeType);
  return decodeSavAttachmentData(part.body ?? {}, expectedSize);
}
