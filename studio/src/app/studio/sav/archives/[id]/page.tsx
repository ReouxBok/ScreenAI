import { notFound } from "next/navigation";
import { z } from "zod";
import { requireSavStaff } from "@/lib/sav/auth";
import { getSavReplyDrafts } from "@/lib/sav/drafts";
import { getSavThreadDetail } from "@/lib/sav/service";
import { legacyCommandNotice } from "@/lib/ui/legacy-notice";
import { safeStudioHref } from "@/lib/ui/navigation-history";
import { BackLink } from "@/components/ui/back-link";
import { Badge, PageHeader } from "@/components/ui/primitives";
import { ArchiveDossierView } from "../archive-view";
import styles from "../archives.module.css";

export const dynamic = "force-dynamic";

// SAV-60: one V0 dossier, strictly read-only. Only audited select-only loaders;
// SavDossierOpened (which records an opening) and every V0 form are absent.
export default async function SavArchiveDossierPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string; kind?: string; returnTo?: string }> }) {
  await requireSavStaff("admin");
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { notice, kind, returnTo } = await searchParams;
  // Direct arrival (new tab, shared link): back to the list page and search the row came from, else to the row itself.
  const listReturn = safeStudioHref(returnTo);
  const fallback = listReturn && new URL(listReturn, "https://studio.invalid").pathname === "/studio/sav/archives" ? listReturn : `/studio/sav/archives#archive-${id}`;
  const [detail, drafts] = await Promise.all([getSavThreadDetail(id), getSavReplyDrafts(id)]);
  if (!detail) notFound();
  const message = legacyCommandNotice(notice, kind === "reply" || kind === "ticket" ? kind : "other");
  return <>
    <PageHeader back={<BackLink fallback={fallback}>Retour</BackLink>} title={detail.thread.subject} status={<Badge>Lecture seule</Badge>}
      description={detail.thread.customerEmail}/>
    {message ? <p className={styles.notice} role="status">{message}</p> : null}
    <p className={styles.readonly}>Archive de l’ancien circuit : consultation seulement. Ouvrir ce dossier ne lance aucune analyse, aucun envoi et ne marque aucun email comme lu.</p>
    <ArchiveDossierView dossier={detail} drafts={drafts.versions}/>
  </>;
}
