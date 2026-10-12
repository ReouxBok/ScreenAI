import { z } from "zod";

const emailSchema = z.email();
const internalAddress = (value: string) => {
  const email = value.trim().replace(/^mailto:/i, "").replace(/^<|>$/g, "").toLowerCase();
  return emailSchema.safeParse(email).success ? email : null;
};

function forwardedHeaderBlocks(body: string) {
  const lines = String(body || "").replace(/\0/g, "").replace(/\r\n?/g, "\n").slice(0, 100_000).split("\n");
  const blocks: Array<{ headers: string[]; body: string }> = [];
  const forwardMarker = /^\s*(?:[- ]*Forwarded message[- ]*|[- ]*Original Message[- ]*|[- ]*Message d['’]origine[- ]*|[- ]*Message transféré[- ]*|Begin forwarded message:)\s*$/i;
  const headerStart = /^\s*(?:From|De)\s*:/i;
  const headerField = /^\s*(?:From|De|Sent|Envoyé|Date|To|À|A|Subject|Objet|Cc|Bcc)\s*:/i;

  for (let index = 0; index < lines.length; index++) {
    const marker = forwardMarker.test(lines[index]);
    const outlook = headerStart.test(lines[index]);
    if (!marker && !outlook) continue;
    const start = marker ? index + 1 : index;
    const headers: string[] = [];
    let bodyStart = start;
    for (let cursor = start; cursor < lines.length; cursor++) {
      if (!lines[cursor].trim()) {
        bodyStart = cursor + 1;
        if (headers.length) break;
        continue;
      }
      if (headerField.test(lines[cursor])) headers.push(lines[cursor]);
      // A folded From can contain a second address. Keep it in the header,
      // never turn it into customer prose and silently retain the first address.
      else if (/^[\t ]/.test(lines[cursor]) && headers.length) headers[headers.length - 1] += ` ${lines[cursor].trim()}`;
      else { bodyStart = cursor; break; }
      bodyStart = cursor + 1;
    }
    // Outlook-style headers must be contiguous. A From mentioned in prose with
    // a Date/Subject further down is not an explicit forwarded-message header.
    if (marker || headers.some(line => /^\s*(?:Sent|Envoyé|Date)\s*:/i.test(line))
      && headers.some(line => /^\s*(?:To|À|A|Subject|Objet)\s*:/i.test(line))) {
      blocks.push({ headers, body: lines.slice(bodyStart).join("\n").trim() });
      index = Math.max(index, bodyStart - 1);
    }
  }
  return blocks;
}

/** Resolve the customer and content from an explicit forwarded-message header only. */
export function resolveSavCustomerMessage(input: { fromEmail: string; subject: string; body: string }) {
  const sender = internalAddress(input.fromEmail);
  if (!sender?.endsWith("@limova.ai")) return { kind: "sender" as const, email: sender, subject: input.subject, body: input.body };

  const parsed: Array<{ email: string; subject: string; body: string } | null> = forwardedHeaderBlocks(input.body).map(block => {
    const fromHeaders = block.headers.filter(line => headerStartPattern.test(line));
    if (fromHeaders.length !== 1) return null;
    const from = fromHeaders[0];
    const value = from.replace(/^\s*(?:From|De)\s*:/i, "");
    const addresses = [...value.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map(match => internalAddress(match[0])).filter((email): email is string => Boolean(email));
    const subject = block.headers.find(line => /^\s*(?:Subject|Objet)\s*:/i.test(line))?.replace(/^\s*(?:Subject|Objet)\s*:/i, "").trim() || input.subject;
    return addresses.length === 1 && !addresses[0].endsWith("@limova.ai") ? { email: addresses[0], subject, body: block.body } : null;
  });
  const valid = parsed.filter((candidate): candidate is { email: string; subject: string; body: string } => candidate !== null);
  const unique = [...new Set(valid.map(candidate => candidate.email))];
  return parsed.length > 0 && !parsed.includes(null) && unique.length === 1
    ? { kind: "forwarded" as const, ...valid[0] }
    : { kind: "unresolved_forward" as const, email: null, subject: input.subject, body: input.body };
}

/** Compact identity safe to persist with the dossier; message content stays in the encrypted source body. */
export function resolveSavCustomerIdentity(input: { fromEmail: string; body: string }) {
  const resolved = resolveSavCustomerMessage({ ...input, subject: "" });
  return { kind: resolved.kind, email: resolved.email };
}

const headerStartPattern = /^\s*(?:From|De)\s*:/i;
