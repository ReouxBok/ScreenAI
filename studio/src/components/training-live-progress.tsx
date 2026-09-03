"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { TrainingConversionForm } from "@/components/training-conversion-form";
import { TrainingRecordingReview } from "@/components/training-recording-review";

type LiveTrainingEvent = {
  id: string;
  ordinal: number;
  kind: string;
  path: string;
  label: string | null;
  payload: Record<string, string | number | boolean | null>;
};

export type TrainingLiveSnapshot = {
  session: {
    id: string;
    status: string;
    contentItemId: string | null;
    recordingStatus: string;
    recordingPathname: string | null;
    recordingSizeBytes: number | null;
    recordingDurationMs: number | null;
    recordingUploadedAt: string | null;
  };
  events: LiveTrainingEvent[];
  rawEventCount: number;
  revision: string;
};

function eventKindLabel(kind: string) {
  if (kind === "voice_note") return "Explication";
  if (kind === "click") return "Clic";
  if (kind === "input") return "Champ utilisé";
  if (kind === "navigation") return "Navigation";
  if (kind === "network") return "Requêtes techniques";
  return "Contexte de page";
}

function clickTargetLabel(payload: Record<string, string | number | boolean | null>) {
  const type = typeof payload.controlType === "string" ? payload.controlType : "contrôle";
  const signals = [
    typeof payload.section === "string" && payload.section ? `section « ${payload.section} »` : "",
    typeof payload.testId === "string" && payload.testId ? `test-id ${payload.testId}` : "",
    typeof payload.elementId === "string" && payload.elementId ? `#${payload.elementId}` : "",
    typeof payload.role === "string" && payload.role ? `rôle ${payload.role}` : "",
  ].filter(Boolean);
  return `Cible exacte : ${type}${signals.length ? ` · ${signals.join(" · ")}` : ""}`;
}

export function TrainingLiveProgress({ initialSnapshot }: { initialSnapshot: TrainingLiveSnapshot }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [temporarilyDisconnected, setTemporarilyDisconnected] = useState(false);
  const failures = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/studio/trainings/${initialSnapshot.session.id}`, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`TRAINING_REFRESH_${response.status}`);
      const next = await response.json() as TrainingLiveSnapshot;
      failures.current = 0;
      setTemporarilyDisconnected(false);
      setSnapshot((current) => current.revision === next.revision ? current : next);
    } catch {
      failures.current += 1;
      if (failures.current >= 3) setTemporarilyDisconnected(true);
    }
  }, [initialSnapshot.session.id]);

  useEffect(() => {
    const shouldPoll = snapshot.session.status === "draft"
      || (snapshot.session.status === "recording" && snapshot.session.recordingStatus !== "ready")
      || snapshot.session.recordingStatus === "uploading";
    if (!shouldPoll) return;

    const initialTimer = window.setTimeout(refresh, 0);
    const timer = window.setInterval(refresh, 1_250);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refresh, snapshot.session.recordingStatus, snapshot.session.status]);

  const mergedCount = Math.max(0, snapshot.rawEventCount - snapshot.events.length);
  const isRecoverable = snapshot.session.status === "recording" && snapshot.session.recordingStatus === "ready";
  return <>
    <div className="training-live-state" aria-live="polite">
      <span className={`status ${isRecoverable ? "ready" : snapshot.session.status}`}>{isRecoverable ? "À finaliser" : snapshot.session.status}</span>
      {snapshot.session.status === "recording" && !isRecoverable ? <span className="training-live-dot">Synchronisation en direct</span> : null}
      {isRecoverable ? <span className="muted">La vidéo est complète : utilisez « Finaliser la démo récupérée » ci-dessus.</span> : null}
      {temporarilyDisconnected && <span className="muted">Reconnexion au direct…</span>}
    </div>
    <TrainingRecordingReview session={snapshot.session}/>
    <section className="timeline-section">
      <div className="section-heading"><div><span className="eyebrow">Ce que Charly a observé</span><h2>{snapshot.events.length} événements utiles</h2>{mergedCount > 0 && <small className="muted">{mergedCount} signaux répétitifs ou techniques fusionnés</small>}</div>
        {snapshot.session.status === "ready" && <TrainingConversionForm sessionId={snapshot.session.id}/>}
        {snapshot.session.contentItemId && <Link className="button secondary" href={`/studio/contenus/${snapshot.session.contentItemId}`}>Ouvrir le parcours</Link>}
      </div>
      <ol className="event-timeline">
        {snapshot.events.map((event, index) => <li key={event.id}><span>{index + 1}</span><div><strong>{eventKindLabel(event.kind)}</strong><p>{event.label || event.path}</p>{event.kind === "click" && <small>{clickTargetLabel(event.payload)}</small>}<small>Page : {event.path}</small></div></li>)}
        {snapshot.events.length === 0 && <div className="empty card">La démonstration n’a pas encore commencé.</div>}
      </ol>
    </section>
  </>;
}
