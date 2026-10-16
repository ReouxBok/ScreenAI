import type { CanonicalKnowledge } from "./contracts";
import type { SavSupportDelivery } from "./support-delivery";

export type SavKnowledgeTab = "production" | "automatic" | "human";
export type SavKnowledgeOrigin = "automatic" | "human" | "unknown";
export type SavKnowledgeSource = { ref: string; label: string };
export type SavKnowledgeRow = {
  id: string; kind: "item" | "candidate" | "draft" | "learning";
  itemId: string | null; candidateId: string | null; draftId: string | null; learningCandidateId: string | null;
  familyId: string | null; title: string; summary: string; origin: SavKnowledgeOrigin;
  state: string; version: number | null; updatedAt: Date; sourceLabel: string;
  activeVersionId: string | null; publishedVersionId: string | null;
  hasPendingUpdate: boolean; nextAction: string;
};
export type SavKnowledgeVersion = { id: string; version: number; title: string; body: string; createdAt: Date; authorEmail: string };
export type SavKnowledgeDraft = {
  delivery?: SavSupportDelivery;
  id: string; revision: number; mode: "new" | "improve"; targetItemId: string | null;
  title: string; document: CanonicalKnowledge; sources: SavKnowledgeSource[]; reason: string;
  origin: SavKnowledgeOrigin; learningCandidateId: string | null; candidateId: string | null;
  status: string; createdBy: string; createdAt: Date; updatedAt: Date;
};
export type SavKnowledgeComparison = { ref: string; title: string; body: string; versionId: string; signal: "duplicate" | "related"; explanation: string };
export type SavKnowledgeDetail = {
  delivery?: SavSupportDelivery;
  reviewKind: "workspace" | "onboarding" | "hubspot" | "legacy" | null;
  row: SavKnowledgeRow; document: CanonicalKnowledge | null; sources: SavKnowledgeSource[];
  activeVersion: SavKnowledgeVersion | null; publishedVersion: SavKnowledgeVersion | null;
  proposedVersion: SavKnowledgeVersion | null; proposedBody: string;
  revisionId: string | null; draft: SavKnowledgeDraft | null;
  comparison: SavKnowledgeComparison[]; snapshot: string | null; missing: string[];
  alerts: string[]; history: Array<{ action: string; actor: string; at: Date; reason: string }>;
  canReview: boolean; canPublish: boolean; canActivate: boolean;
};
