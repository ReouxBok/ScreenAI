import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSavStaff } from "@/lib/sav/auth";
import { getSavKnowledgeDetail } from "@/lib/knowledge/workspace";
import { KnowledgeProposalForm } from "../proposal-form";
import styles from "../workspace.module.css";

export const dynamic = "force-dynamic";
export default async function ProposeKnowledgePage({ searchParams }: { searchParams: Promise<{ draft?: string; target?: string; learning?: string }> }) {
  const staff = await requireSavStaff();
  const query = await searchParams;
  for (const id of [query.draft, query.target, query.learning]) if (id && !/^[a-f0-9-]{36}$/i.test(id)) notFound();
  const initial = query.draft || query.target || query.learning ? await getSavKnowledgeDetail({ draftId: query.draft, itemId: query.target, learningCandidateId: query.learning }, staff.email) : null;
  if ((query.draft || query.target || query.learning) && !initial) notFound();
  return <div className={styles.workspace}><Link className="back-link" href="/studio/sav/connaissances">← Bibliothèque des connaissances</Link><div className={styles.heading}><div><span className="eyebrow">Proposition interne</span><h1>Proposer une connaissance</h1><p className={styles.subtle}>Une nouvelle procédure ou une amélioration sourcée, avec une revue humaine avant utilisation.</p></div></div><KnowledgeProposalForm key={initial?.draft?.id ?? initial?.row.id ?? "new"} initial={initial} learningCandidateId={initial?.draft?.learningCandidateId ?? query.learning}/></div>;
}
