"use client";

import { useActionState } from "react";
import { convertTrainingAction, type TrainingConversionState } from "@/app/studio/entrainements/actions";

const initialState: TrainingConversionState = {};

export function TrainingConversionForm({ sessionId }: { sessionId: string }) {
  const [state, action, pending] = useActionState(convertTrainingAction, initialState);
  return <form action={action} className="training-conversion-form">
    <input type="hidden" name="sessionId" value={sessionId}/>
    <button className="primary" disabled={pending}>{pending ? "Création du parcours…" : "Transformer en parcours"}</button>
    {state.error && <p className="login-error conversion-error" role="alert">{state.error}</p>}
  </form>;
}
