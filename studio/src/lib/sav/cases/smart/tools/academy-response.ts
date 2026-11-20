import { z } from "zod";

const MAX_RESPONSE_BYTES = 64 * 1024;

type AcademyRpcReply =
  | { status: "ok"; result: unknown }
  | { status: "invalid_response" | "response_too_large" | "unavailable" };

const envelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

function parseEnvelope(text: string, requestId: number): AcademyRpcReply | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { status: "invalid_response" };
  }
  const envelope = envelopeSchema.safeParse(data);
  if (!envelope.success) return { status: "invalid_response" };
  if (envelope.data.id !== requestId) return undefined;
  if (envelope.data.error !== undefined) return { status: "unavailable" };
  if (envelope.data.result === undefined) return { status: "invalid_response" };
  return { status: "ok", result: envelope.data.result };
}

export async function readAcademyReply(response: Response, requestId: number): Promise<AcademyRpcReply> {
  if (!response.body) return { status: "invalid_response" };

  const mediaType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let buffer = "";
  let eventData: string[] = [];

  try {
    if (mediaType !== "text/event-stream" && mediaType !== "application/json") {
      return { status: "invalid_response" };
    }
    for (;;) {
      const { done, value } = await reader.read();
      bytes += value?.byteLength ?? 0;
      if (bytes > MAX_RESPONSE_BYTES) return { status: "response_too_large" };
      buffer += decoder.decode(value, { stream: !done });

      if (mediaType === "application/json") {
        if (done) return parseEnvelope(buffer, requestId) ?? { status: "invalid_response" };
        continue;
      }

      // Retain an incomplete line, including a CR that might begin a split CRLF.
      const lines = buffer.split(done ? /\r\n|\r|\n/ : /\r\n|\n|\r(?!$)/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "data" || line.startsWith("data:")) {
          eventData.push(line.slice(5).replace(/^ /, ""));
        } else if (line === "" && eventData.length > 0) {
          const reply = parseEnvelope(eventData.join("\n"), requestId);
          if (reply) return reply;
          eventData = [];
        }
      }
      if (done) return { status: "invalid_response" };
    }
  } finally {
    // MCP may leave the stream open after dispatching the matching response.
    void reader.cancel().catch(() => {});
  }
}
