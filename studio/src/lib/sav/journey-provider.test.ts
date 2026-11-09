import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

describe("journey provider history", () => {
  it("links all five recent activity types, verifies them and still blocks unknown network", () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "sav-journey-provider-test-")));
    const studio = process.cwd();
    mkdirSync(path.join(root, "test"));
    copyFileSync(path.join(studio, "test/sav-journey-provider.mjs"), path.join(root, "test/provider.mjs"));
    const types = ["calls", "emails", "notes", "meetings", "tasks"];
    const now = new Date("2026-11-09T12:00:00.000Z");
    const activities = Object.fromEntries(types.map((type, i) => [type, [{ id: String(7000 + i), contactId: "990001", properties: { hs_timestamp: new Date(now.getTime() - 86400000).toISOString() } }]]));
    writeFileSync(path.join(root, ".e2e-journey-provider.json"), JSON.stringify({ cases: { create: { contactId: "990001" } }, tickets: {}, notes: {}, events: [], activities }));
    const code = `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      let escaped=0;
      globalThis.fetch=async()=>{escaped++;throw Error('TEST_REAL_NETWORK_FORBIDDEN')};
      await import(${JSON.stringify(path.join(root, "test/provider.mjs"))});
      const {collectTicketCreationHistory,ticketCreationAssociations,verifyTicketCreationHistory}=await import(${JSON.stringify(path.join(studio, "src/lib/sav/ticket-creation-history.ts"))});
      const read=async(route,body)=>{const r=await fetch('https://api.hubapi.com'+route,body===undefined?{}:{method:'POST',body:JSON.stringify(body)});assert.equal(r.ok,true);return r.json()};
      const history=await collectTicketCreationHistory('990001',read,new Date('2026-11-09T12:00:00.000Z'));
      assert.equal(history.activities.length,5);
      const ticket=await read('/crm/v3/objects/tickets',{properties:{subject:'Synthetic history'},associations:ticketCreationAssociations(history)});
      assert.equal(await verifyTicketCreationHistory(ticket.id,history,read),true);
      const remote=JSON.parse(readFileSync(${JSON.stringify(path.join(root, ".e2e-journey-provider.json"))},'utf8'));
      assert.equal(remote.events.filter(e=>e.kind==='create').length,1);
      assert.deepEqual(Object.keys(remote.notes),[]);
      for(const row of history.activities)assert(remote.tickets[ticket.id].associations[row.type].results.some(x=>x.id===row.id));
      await assert.rejects(fetch('https://unapproved.example.invalid/test'),/JOURNEY_UNEXPECTED_NETWORK_BLOCKED/);
      assert.equal(escaped,0);
      console.log(JSON.stringify({activities:5,verified:true,creates:1,realNetworkCalls:escaped}));
    `;
    try {
      const result = execFileSync(process.execPath, ["--import", path.join(studio, "node_modules/tsx/dist/loader.mjs"), "--input-type=module", "-e", code], {
        encoding: "utf8", env: { PATH: process.env.PATH, NODE_ENV: "test", SAV_JOURNEY_E2E: "synthetic-loopback-only", DATABASE_URL: `pglite://${path.join(root, ".e2e-journey-db")}`, HUBSPOT_ACCESS_TOKEN: "synthetic-journey-only" },
      });
      expect(JSON.parse(result.trim())).toEqual({ activities: 5, verified: true, creates: 1, realNetworkCalls: 0 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
