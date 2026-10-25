import { z } from "zod";
export const operatorCommandSchema = z.object({
  requestKey: z.uuid(), threadId: z.uuid(), messageId: z.uuid(), runId: z.uuid(), version: z.number().int().positive(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/), kind: z.enum(["resume", "reanalyse", "information"]),
  reason: z.string().trim().min(10).max(2000), information: z.string().trim().min(1).max(2000).optional(),
  expectedInformationId: z.uuid().nullable().optional(),
}).strict().superRefine((v, ctx) => {
  if (v.kind === "information" ? !v.information || v.expectedInformationId === undefined : v.information !== undefined)
    ctx.addIssue({ code: "custom", message: "Information revision required only for information commands" });
});
export type OperatorCommand = z.infer<typeof operatorCommandSchema>;
export type OperatorStep = "reads" | "analysis" | "admission" | "execution" | "verify_only" | "reanalysis";
export type OperatorReceipt = { id: string; step: OperatorStep; state: string; at: string; outcome?: string; checked?:number; reason?: string; nextAt?: string; informationId?: string; consumedAt?: string };
