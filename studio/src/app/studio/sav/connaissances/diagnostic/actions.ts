"use server";
import { requireSavApiStaff } from "@/lib/sav/auth";
import { prepareSavDiagnosticEnrichment } from "@/lib/knowledge/diagnostic-enrichment";
import { z } from "zod";
export async function prepareDiagnosticPage(after?: string) {
  const staff = await requireSavApiStaff();
  return prepareSavDiagnosticEnrichment({ afterId: z.uuid().optional().parse(after) }, staff.email);
}
