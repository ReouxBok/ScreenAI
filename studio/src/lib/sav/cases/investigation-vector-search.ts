import { createSavKnowledgeVectorIndex } from "../request-retrieval-db";
import type { CaseKnowledgeVectorSearch } from "./investigation-budgeted-retrieval";

/*
 * SAV-7/SAV-19 (night 31/10, lot 2): the budgeted search's vector port on the SAV knowledge index. It searches with
 * the vectors the budgeted search already paid for (investigation-budgeted-retrieval.ts) and never embeds: the index
 * it uses has no embedding call. Same SQL, filters, language, revision and limits as the V1 backend. One per run, as
 * the validity date is fixed when it is made. Local and OFF: nothing wires it.
 */
export function caseKnowledgeVectorSearchOnDb(scope: { locale: string; audience: "support" | "lead"; now: Date }): CaseKnowledgeVectorSearch {
  const index = createSavKnowledgeVectorIndex(scope);
  return {
    dimension: index.dimension,
    readRevision: () => index.readRevision(),
    available: () => index.available(),
    search: (queries, vectors, limit) => index.searchByVectors(queries, vectors, limit),
  };
}
