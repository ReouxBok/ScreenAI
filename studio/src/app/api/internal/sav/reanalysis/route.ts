import { currentUser } from "@clerk/nextjs/server";
import { randomBytes } from "node:crypto";
import { getStaffDirectoryEntry, hasRole, normalizeStaffEmail } from "@/lib/access";
import { withReanalysisDatabase } from "@/lib/sav/reanalysis-database";
import { reanalysisServerRequest, runSavReanalysisServer } from "@/lib/sav/reanalysis-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

async function isOperator() {
  const user = await currentUser();
  const email = normalizeStaffEmail(user?.primaryEmailAddress?.emailAddress, "");
  const staff = getStaffDirectoryEntry(email);
  return Boolean(user && email === "ugo@limova.ai" && user.primaryEmailAddress?.verification?.status === "verified" && staff && hasRole(staff.role, "admin"));
}

/** Private operator surface uses the existing session; no cookies or secrets exported. */
export async function GET() {
  if (!await isOperator()) return Response.json({ error: "forbidden" }, { status: 403, headers });
  const nonce = randomBytes(24).toString("base64");
  return new Response(`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Opération SAV privée</title>
<h1>Réanalyse SAV — candidatures séparées</h1><p>Réservé à Ugo. Aucun envoi, aucune action CRM, aucune adoption. Les versions humaines et les pauses sont conservées. Ne lancer que la cohorte et les opérations autorisées.</p>
<label for="request">Requête opérateur privée (une opération ou une liste de 20 maximum)</label><br><textarea id="request" rows="12" cols="100" spellcheck="false">{"op":"capabilities"}</textarea><br>
<button id="run">Exécuter les opérations autorisées</button><p id="status" role="status">Prêt. Aucun appel lancé.</p><pre id="result"></pre>
<script nonce="${nonce}">
const button=document.getElementById('run'),status=document.getElementById('status'),output=document.getElementById('result');
button.addEventListener('click',async()=>{button.disabled=true;output.textContent='';const receipts=[];
try{const value=JSON.parse(document.getElementById('request').value),inputs=Array.isArray(value)?value:[value];if(!inputs.length||inputs.length>20)throw Error('Liste refusée');
for(const input of inputs){status.textContent='Opération '+(receipts.length+1)+' / '+inputs.length+' en cours';
const response=await fetch('/api/internal/sav/reanalysis',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
const result=await response.json();receipts.push({status:response.status,result});output.textContent=JSON.stringify(receipts,null,2);
if(!response.ok||result.results?.some(item=>item.state!=='ready'&&item.state!=='already_claimed')){status.textContent='Arrêt : résultat à examiner. Ne pas relancer automatiquement.';return;}}
status.textContent='Terminé. Examiner les reçus et comparer avant de poursuivre.';
}catch{status.textContent='Interruption ou requête invalide. Rapprocher les reçus avant toute reprise, sans relance automatique.';}
finally{button.disabled=false;}});
</script></html>`, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` } });
}

export async function POST(request: Request) {
  try {
    if (!await isOperator())
      return Response.json({ error: "forbidden" }, { status: 403, headers });
    if (request.headers.get("origin") !== new URL(request.url).origin || !request.headers.get("content-type")?.startsWith("application/json"))
      return Response.json({ error: "invalid_request" }, { status: 400, headers });
    const reader = request.body?.getReader();
    if (!reader) return Response.json({ error: "invalid_request" }, { status: 400, headers });
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > 131_072) { await reader.cancel(); return Response.json({ error: "too_large" }, { status: 413, headers }); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const parsed = reanalysisServerRequest.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400, headers });
    const result = await withReanalysisDatabase(() => runSavReanalysisServer(parsed.data));
    return Response.json(result, { headers });
  } catch {
    // No provider errors, secrets or customer content in request logs.
    console.warn("sav_reanalysis_server_request_refused");
    return Response.json({ error: "reanalysis_refused_or_failed" }, { status: 409, headers });
  }
}
