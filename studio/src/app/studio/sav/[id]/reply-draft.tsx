import type { getSavReplyDrafts } from "@/lib/sav/drafts";
import type { getSavProposalReview } from "@/lib/sav/review";
import { saveReplyDraftAction } from "../actions";
const labels: Record<string, string> = { draft: "Brouillon", validated: "Validé en interne", abandoned: "Abandonné" };
export function ReplyDraft({ drafts, proposal, threadId, messageId }: { drafts: Awaited<ReturnType<typeof getSavReplyDrafts>>; proposal: NonNullable<Awaited<ReturnType<typeof getSavProposalReview>>>; threadId: string; messageId: string }) {
  const current = drafts.versions.find((d) => d.isCurrent);
  return <section className="sav-draft card" aria-labelledby="studio-draft-title"><header><div><span className="eyebrow">Studio uniquement · aucun envoi</span><h2 id="studio-draft-title">Brouillon de réponse</h2></div><span>{current ? current.stale ? "Obsolète" : labels[current.status] : "Non enregistré"}</span></header>
    {current?.stale && <p role="status">Le contexte a changé (email, proposition ou connaissance). Relisez la proposition actuelle et enregistrez une nouvelle version ; l’ancienne ne peut plus être validée.</p>}
    <p>Cette validation est interne. Elle ne crée aucun brouillon Gmail ou HubSpot et n’envoie aucun email.</p>
    <form action={saveReplyDraftAction} key={`${current?.id ?? "new"}:${proposal.review?.id ?? "unreviewed"}`}>
      <input type="hidden" name="threadId" value={threadId}/><input type="hidden" name="messageId" value={messageId}/><input type="hidden" name="decisionId" value={proposal.decisionId}/><input type="hidden" name="agentRunId" value={proposal.agentRunId}/><input type="hidden" name="reviewId" value={proposal.review?.id ?? ""}/><input type="hidden" name="knowledgeRevision" value={drafts.knowledgeRevision ?? ""}/><input type="hidden" name="draftId" value={current?.id ?? ""}/>
      <label>Réponse à conserver dans le Studio<textarea name="text" rows={6} required maxLength={10_000} defaultValue={!current?.stale && current?.status !== "abandoned" ? current?.text ?? proposal.proposal.replyDraft ?? "" : proposal.proposal.replyDraft ?? ""}/></label>
      <div className="decision-buttons"><button className="secondary" name="status" value="draft">Enregistrer une version</button><button className="primary" name="status" value="validated" disabled={proposal.review?.status !== "approved" || Boolean(current?.stale)}>Valider en interne</button><button className="secondary" name="status" value="abandoned">Abandonner le brouillon</button></div>
      {proposal.review?.status !== "approved" && <p>Validez d’abord le process. Vous pouvez déjà enregistrer le brouillon.</p>}
    </form>
    <details><summary>Historique des versions ({drafts.versions.length}{drafts.versions.length === 50 ? " dernières" : ""})</summary>{drafts.versions.map((d) => <article key={d.id}><p>Version {d.revision} · {labels[d.status]}{d.stale ? " · contexte obsolète" : ""} · {d.createdBy} · {d.createdAt.toLocaleString("fr-FR")}</p><pre>{d.text}</pre></article>)}</details>
  </section>;
}
