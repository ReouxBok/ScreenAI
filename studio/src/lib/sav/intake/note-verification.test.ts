import { expect, it } from "vitest";
import { executionProvider } from "../../../../test/sav-intake-execution-provider";
import { createIntakeExecutorAdapters, renderIntakeNote } from "./execution-adapters";
import type { EffectAck, EffectIntent } from "./execution-types";

const marker = "a".repeat(64), at = new Date("2026-01-01T12:00:00Z"), timestamp = at.toISOString();
const text = "Synthetic <request> & detail.\nExact next line.";
const legacyBody = `<p>Synthetic &lt;request&gt; &amp; detail.<br>Exact next line.</p><!-- sav-intake:${marker} -->`;
const strippedBody = legacyBody.slice(0, legacyBody.indexOf("<!--"));
function note(legacy = false): EffectIntent {
    return { kind: "note_create", permission: "append_ticket_note", key: "synthetic-note", sourceMessageId: "synthetic-source", ticketId: "201", text, marker,
        properties: { hs_note_body: legacy ? legacyBody : renderIntakeNote(text, marker), hs_timestamp: timestamp } };
}
function fixture(intent = note()) {
    const provider = executionProvider();
    provider.objects.notes["901"] = { id: "901", properties: { ...intent.properties } };
    return { provider, adapter: createIntakeExecutorAdapters({ network: provider.network, env: () => ({ HUBSPOT_ACCESS_TOKEN: "synthetic" }) }) };
}
const signal = () => AbortSignal.timeout(1000);
const rejected = { confirmed: false, attributed: false };

it("creates a note with an escaped visible marker preserved when comments are removed", async () => {
    const intent = note(), f = fixture();
    const ack = await f.adapter.dispatch(intent, signal());
    const created = f.provider.objects.notes[ack.id!];
    expect(created.properties.hs_note_body).toBe(`<p>Synthetic &lt;request&gt; &amp; detail.<br>Exact next line.</p><p>[Studio intake: ${marker}]</p>`);
    expect(created.properties.hs_note_body).not.toContain("<!--");
    created.properties.hs_note_body = created.properties.hs_note_body!.replace(/<!--[\s\S]*?-->/g, "") + "\n";
    expect(await f.adapter.verify(intent, ack, at, signal())).toMatchObject({ confirmed: true, attributed: true, ack });
    expect(renderIntakeNote("<>&\"'", "<marker>")).toContain("&lt;marker&gt;");
});
it.each([false, true])("recovers a new persistent marker without ACK, trailing LF=%s", async lf => {
    const intent = note(), f = fixture(intent);
    if (lf) f.provider.objects.notes["901"].properties.hs_note_body += "\n";
    expect(await f.adapter.verify(intent, null, at, signal())).toMatchObject({ confirmed: true, attributed: true, ack: { id: "901" } });
    expect(f.provider.calls.every(c => c.method === "GET" || c.path.endsWith("/search"))).toBe(true);
});
it.each([false, true])("recovers only the exact historical comment removal with stored ACK, trailing LF=%s", async lf => {
    const intent = note(true), f = fixture(intent);
    f.provider.objects.notes["901"].properties.hs_note_body = strippedBody + (lf ? "\n" : "");
    expect(await f.adapter.verify(intent, { id: "901" }, at, signal())).toMatchObject({ confirmed: true, attributed: true, ack: { id: "901" } });
    expect(f.provider.calls.every(c => c.method === "GET")).toBe(true);
});
it("retains marker-based historical recovery when the original comment is still present", async () => {
    const intent = note(true), f = fixture(intent);
    expect(await f.adapter.verify(intent, null, at, signal())).toMatchObject({ confirmed: true, attributed: true });
});
it.each([null, { id: "901", operatorCandidate: true }, {}] as (EffectAck | null)[])("does not attribute stripped historical text without a provider ACK: %j", async ack => {
    const intent = note(true), f = fixture(intent);
    f.provider.objects.notes["901"].properties.hs_note_body = strippedBody + "\n";
    expect(await f.adapter.verify(intent, ack, at, signal())).toMatchObject(rejected);
});
it.each(["text", "truncated", "timestamp", "missing-timestamp", "invalid-timestamp", "id", "marker", "intent-marker", "double-lf", "crlf", "whitespace", "other-comment", "malformed-legacy", "extra-property"])("rejects historical %s mismatch despite ACK", async change => {
    const intent = note(true), f = fixture(intent), row = f.provider.objects.notes["901"];
    row.properties.hs_note_body = strippedBody;
    if (change === "text") row.properties.hs_note_body = strippedBody.replace("Exact", "Changed");
    if (change === "truncated") row.properties.hs_note_body = strippedBody.slice(0, -5);
    if (change === "timestamp") row.properties.hs_timestamp = new Date(at.getTime() + 1).toISOString();
    if (change === "missing-timestamp") delete row.properties.hs_timestamp;
    if (change === "invalid-timestamp") row.properties.hs_timestamp = "invalid";
    if (change === "id") row.id = "902";
    if (change === "marker") row.properties.hs_note_body = legacyBody.replace(marker, "b".repeat(64));
    if (change === "intent-marker") intent.marker = "b".repeat(64);
    if (change === "double-lf") row.properties.hs_note_body += "\n\n";
    if (change === "crlf") row.properties.hs_note_body += "\r\n";
    if (change === "whitespace") row.properties.hs_note_body += " ";
    if (change === "other-comment") { intent.properties!.hs_note_body = legacyBody.replace("sav-intake:", "other:"); }
    if (change === "malformed-legacy") { intent.properties!.hs_note_body = legacyBody.replace("<br>", "<br/>"); }
    if (change === "extra-property") { intent.properties!.other = "required"; }
    expect(await f.adapter.verify(intent, { id: "901" }, at, signal())).toMatchObject(rejected);
});
it.each(["body", "timestamp", "marker"])("rejects changed new note %s despite ACK", async change => {
    const intent = note(), f = fixture(intent), row = f.provider.objects.notes["901"];
    if (change === "body") row.properties.hs_note_body += "Edited";
    if (change === "timestamp") row.properties.hs_timestamp = new Date(at.getTime() + 1).toISOString();
    if (change === "marker") row.properties.hs_note_body = row.properties.hs_note_body!.replace(marker, "b".repeat(64));
    expect(await f.adapter.verify(intent, { id: "901" }, at, signal())).toMatchObject(rejected);
});
it.each(["duplicate", "pagination", "wrong-read-id"])("rejects ambiguous marker lookup: %s", async change => {
    const intent = note(), f = fixture(intent);
    if (change === "duplicate") f.provider.objects.notes["902"] = { id: "902", properties: { ...intent.properties } };
    const network: typeof fetch = async (url, init) => {
        const result = await f.provider.network(url, init);
        if (change === "pagination" && String(url).endsWith("/search")) return Response.json({ ...await result.json(), paging: { next: { after: "2" } } });
        if (change === "wrong-read-id" && new URL(String(url)).pathname.endsWith("/901")) return Response.json({ ...await result.json(), id: "902" });
        return result;
    };
    const adapter = createIntakeExecutorAdapters({ network });
    expect(await adapter.verify(intent, null, at, signal())).toMatchObject(rejected);
});
function associationIntent(): EffectIntent {
    return { ...note(true), kind: "note_associate", objectId: "901", expectedProperties: note(true).properties,
        confirmedNoteCreate: { effectId: "synthetic-confirmed-create", objectId: "901" } };
}
it("verifies the stripped historical note association bound to a confirmed creation and exact ticket", async () => {
    const intent = associationIntent(), f = fixture(note(true));
    f.provider.objects.notes["901"].properties.hs_note_body = strippedBody + "\n";
    f.provider.links.set("notes:901:tickets", ["201"]);
    expect(await f.adapter.verify(intent, { id: "901" }, at, signal())).toMatchObject({ confirmed: true, attributed: true, observedHistory: { id: "notes:901", text: strippedBody + "\n", at: timestamp } });
});
it.each(["ticket", "id", "ack-id", "text", "timestamp", "missing-provenance", "wrong-create-id"])("rejects historical association %s mismatch", async change => {
    const intent = associationIntent(), f = fixture(note(true)), row = f.provider.objects.notes["901"];
    row.properties.hs_note_body = strippedBody;
    f.provider.links.set("notes:901:tickets", ["201"]);
    if (change === "ticket") f.provider.links.set("notes:901:tickets", ["202"]);
    if (change === "id") row.id = "902";
    if (change === "text") row.properties.hs_note_body += "Edited";
    if (change === "timestamp") row.properties.hs_timestamp = new Date(at.getTime() + 1).toISOString();
    if (change === "missing-provenance") delete intent.confirmedNoteCreate;
    if (change === "wrong-create-id") intent.confirmedNoteCreate!.objectId = "902";
    expect(await f.adapter.verify(intent, { id: change === "ack-id" ? "902" : "901" }, at, signal())).toMatchObject(rejected);
});
