import { z } from "zod";

export const orientationSchema = z.object({
  commandKey: z.uuid(), threadId: z.uuid(), messageId: z.uuid(), runId: z.uuid(), version: z.number().int().positive(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/), candidatesHash: z.string().regex(/^[a-f0-9]{64}$/),
  intent: z.enum(["orient", "refuse"]), classification: z.enum(["support", "finance", "cancellation", "partnership", "commercial", "investor", "other"]),
  contactId: z.string().regex(/^\d{1,30}$/).optional(), ticketId: z.string().regex(/^\d{1,30}$/).optional(),
  reason: z.string().trim().min(10).max(2000),
}).strict().superRefine((value, ctx) => {
  if (value.intent === "orient" && !orientationSupportsTickets(value.classification) && (value.contactId || value.ticketId))
    ctx.addIssue({ code: "custom", path: ["ticketId"], message: "Cette catégorie ne propose pas de cible ticket." });
});
export type Orientation = z.infer<typeof orientationSchema>;
export const orientationLabels: Record<Orientation["classification"], string> = {
  support: "Support", finance: "Facturation", cancellation: "Résiliation", partnership: "Partenariat", commercial: "Commercial", investor: "Investisseur", other: "Autres",
};
export function orientationSupportsTickets(classification: string) { return ["support", "finance", "cancellation"].includes(classification); }
export function orientationCommand(input: Orientation) {
  const { intent, classification, contactId, ticketId, ...binding } = orientationSchema.parse(input);
  // One immutable event carries ALL visible orientation fields; never select then classify.
  return intent === "refuse" ? { ...binding, kind: "refuse" as const }
    : { ...binding, kind: "classify" as const, classification,
      ...(contactId ? { contactId } : {}), ...(ticketId ? { ticketId } : {}) };
}
export function orientationPreview(input: Pick<Orientation, "intent" | "classification" | "contactId" | "ticketId">) {
  if (input.intent === "refuse") return "La proposition sera arrêtée pour ce message. Les actions déjà accomplies restent conservées ; les résultats incertains restent à vérifier.";
  if (!Object.hasOwn(orientationLabels, input.classification)) return "Choisissez la catégorie de la demande avant d’enregistrer une orientation.";
  if (input.classification === "other") return "Classement Autres proposé après vérification. Le mail et son historique sont conservés ; aucun ticket n’est créé ni rattaché par cette orientation.";
  if (!orientationSupportsTickets(input.classification)) return `Catégorie proposée : ${orientationLabels[input.classification]}. Prise en charge par l’équipe, sans rattachement de ticket proposé. Une éventuelle action supervisée conserve sa validation propre.`;
  const target = input.ticketId ? "Le ticket sélectionné sera proposé au rattachement après vérification du sujet et de sa fiche."
    : input.contactId ? "La fiche sélectionnée sera réexaminée avec ses tickets avant le choix de l’action." : "Le moteur réexaminera la destination selon les sources et la catégorie retenue.";
  return `Catégorie proposée : ${orientationLabels[input.classification]}. ${target} Les opérations intake autorisées peuvent suivre cette vérification. Aucun remboursement ni résiliation n’est effectué par cette correction.`;
}
