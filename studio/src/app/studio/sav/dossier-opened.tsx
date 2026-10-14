"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { savDashboardReturnHref } from "@/lib/sav/dashboard-state";
import { recordSavDossierOpenedAction } from "./open-email-actions";

/** Only mounted content counts as opened; server rendering and prefetch do not. */
export function SavDossierOpened({ threadId, messageId }: { threadId: string; messageId: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let mounted = true;
    recordSavDossierOpenedAction(threadId, messageId).then(result => { if (mounted) setFailed(!result.ok); }).catch(() => { if (mounted) setFailed(true); });
    return () => { mounted = false; };
  }, [threadId, messageId]);
  return failed ? <p className="login-notice error" role="status">La consultation n’a pas pu être enregistrée. Le dossier peut encore apparaître dans « À traiter ». Rechargez le dossier pour réessayer.</p> : null;
}

/** Keeps the inbox position through existing dossier POST redirects. Only local
 * validated inbox URLs are stored, no mail content or third-party destinations. */
export function SavDossierBackLink({ threadId, returnTo }: { threadId: string; returnTo?: string }) {
  const key = `sav-inbox-return:${threadId}`;
  const safeHref = savDashboardReturnHref(returnTo);
  useEffect(() => {
    if (!returnTo || safeHref === "/studio/sav") return;
    try { sessionStorage.setItem(key, safeHref); window.dispatchEvent(new Event("sav-inbox-return")); } catch { /* Storage may be disabled. */ }
  }, [key, returnTo, safeHref]);
  const saved = useSyncExternalStore(subscribeReturnLink, () => {
    if (returnTo && safeHref !== "/studio/sav") return safeHref;
    try { return savDashboardReturnHref(sessionStorage.getItem(key)); } catch { return "/studio/sav"; }
  }, () => safeHref);
  return <Link href={saved}>← Retour aux dossiers</Link>;
}
function subscribeReturnLink(callback: () => void) {
  window.addEventListener("sav-inbox-return", callback);
  return () => window.removeEventListener("sav-inbox-return", callback);
}
