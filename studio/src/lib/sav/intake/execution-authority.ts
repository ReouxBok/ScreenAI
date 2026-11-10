/** Night V1 (C, cycle 1 M-2): pure labels of the execution authority state (reader in execution-policy.ts). Codes only. */
export type IntakeExecutionAuthorityState = "off" | "valid" | "code_revision_changed" | "expired" | "revoked" | "not_approved" | "policy_missing"
    | "configuration_mismatch" | "approver_unauthorized" | "policy_incoherent" | "disabled" | "configuration_required" | "unreadable";
export const intakeExecutionAuthorityLabels: Record<Exclude<IntakeExecutionAuthorityState, "valid">, string> = {
    off: "Exécution automatique désactivée : les analyses restent en observation.",
    code_revision_changed: "Exécution automatique suspendue : l’autorisation approuvée vise une autre version du code (nouveau déploiement). Une nouvelle approbation est nécessaire ; aucune action n’est lancée.",
    expired: "Exécution automatique suspendue : l’autorisation approuvée a expiré. Une nouvelle approbation est nécessaire ; aucune action n’est lancée.",
    revoked: "Exécution automatique suspendue : l’autorisation a été révoquée.",
    not_approved: "Exécution automatique suspendue : l’autorisation configurée n’est pas dans l’état approuvé.",
    policy_missing: "Exécution automatique suspendue : l’autorisation configurée pour ce déploiement est introuvable (erreur de configuration).",
    configuration_mismatch: "Exécution automatique suspendue : l’empreinte configurée ne correspond pas à l’autorisation approuvée (erreur de configuration).",
    approver_unauthorized: "Exécution automatique suspendue : l’approbateur de l’autorisation n’est plus habilité.",
    policy_incoherent: "Exécution automatique suspendue : le contenu de l’autorisation ne correspond pas à son empreinte approuvée.",
    disabled: "Exécution automatique coupée par l’interrupteur d’écriture.",
    configuration_required: "Exécution automatique non configurée pour ce déploiement.",
    unreadable: "État de l’autorisation d’exécution illisible : aucune absence de blocage n’est affirmée.",
};
