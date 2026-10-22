/** Clean loopback fixture: no provider traffic is permitted. */
import { appendFileSync } from "node:fs";
import path from "node:path";
if (process.env.NODE_ENV === "production" || process.env.SAV83_E2E !== "synthetic-loopback-only" || process.env.DATABASE_URL !== `pglite://${path.resolve(".e2e-sav83-db")}`) throw new Error("SAV83_PROVIDER_ISOLATION_REFUSED");
const network = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname) && url.port === "3183") return network(input, init);
  if (url.hostname === "registry.npmjs.org" && url.pathname === "/-/package/next/dist-tags") return Response.json({ latest: "16.3.8" });
  appendFileSync(path.resolve(".e2e-sav83-network.log"), `${url.hostname}${url.pathname}\n`);
  throw new Error("SAV83_EXTERNAL_NETWORK_BLOCKED");
};
