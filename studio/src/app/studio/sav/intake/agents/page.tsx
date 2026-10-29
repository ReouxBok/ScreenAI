import Link from "next/link";
import { formatParisDateTime } from "@/lib/paris-date";
import { requireIntakeConsoleStaff } from "@/lib/sav/intake/console-auth";
import { listStudioMcpTokens, STUDIO_MCP_TOKEN, STUDIO_MCP_TOKEN_HISTORY } from "@/lib/mcp/tokens";
import { studioMcpConfig } from "@/lib/mcp/config";
import { CreateAgentKeyForm, RevokeAgentKeyForm } from "./agent-key-forms";
import styles from "../intake.module.css";
export const dynamic = "force-dynamic";
export default async function AgentKeysPage() {
  const staff = await requireIntakeConsoleStaff(), keys = await listStudioMcpTokens(staff), config = studioMcpConfig();
  const active = keys.filter(key => key.state === "active"), history = keys.filter(key => key.state !== "active");
  return <div className={styles.console}>
    <Link className={styles.back} href="/studio/sav/intake">← Nouveaux dossiers</Link>
    <header className={styles.heading}><div><span className="eyebrow">SAV · accès agents</span><h1>Clés pour Claude et Codex</h1>
      <p>Une clé personnelle permet à Claude Code ou Codex de lire les dossiers SAV à votre place, avec vos droits, sans navigateur.</p></div></header>
    {!config.enabled && <p role="status">Le serveur MCP du Studio est désactivé : une clé créée maintenant ne fonctionnera qu’après son activation.</p>}
    <CreateAgentKeyForm days={STUDIO_MCP_TOKEN.days} defaultDays={STUDIO_MCP_TOKEN.defaultDays}/>
    <section className={styles.choice}>
      <h2>Clés actives</h2>
      {active.length ? <ul>{active.map(key => <li key={key.id}><strong>{key.name}</strong> · <code>{key.prefix}…</code> · active jusqu’au {formatParisDateTime(key.expiresAt)}
        {key.lastUsedAt && <> · dernier usage {formatParisDateTime(key.lastUsedAt)}</>}<RevokeAgentKeyForm id={key.id}/></li>)}</ul> : <p>Aucune clé active.</p>}
    </section>
    {history.length > 0 && <section className={styles.choice}>
      <h2>Historique</h2>
      <p>Les {STUDIO_MCP_TOKEN_HISTORY} dernières clés révoquées ou expirées.</p>
      <ul>{history.map(key => <li key={key.id}><strong>{key.name}</strong> · <code>{key.prefix}…</code> · {key.state === "revoked" && key.revokedAt ? `révoquée le ${formatParisDateTime(key.revokedAt)}` : `expirée le ${formatParisDateTime(key.expiresAt)}`}
        {key.lastUsedAt && <> · dernier usage {formatParisDateTime(key.lastUsedAt)}</>}</li>)}</ul>
    </section>}
    <section className={styles.choice}>
      <h2>Configurer Claude Code</h2>
      <p>Placez la clé dans une variable d’environnement (<code>STUDIO_MCP_KEY</code>) plutôt qu’en clair, puis :</p>
      <pre><code>{`claude mcp add --transport http studio-sav https://studio.limova.ai/api/mcp --header "Authorization: Bearer $STUDIO_MCP_KEY"`}</code></pre>
    </section>
  </div>;
}
