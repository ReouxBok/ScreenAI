export async function diagnoseLimovaClient(client, selection, signal = AbortSignal.timeout(15_000)) {
  const checks = [];
  const add = (name, status, detail, code) => checks.push({ name, status, detail, code });
  let current;
  try {
    current = await client.bootstrap(signal);
    add('limovaSession', 'ok', 'Session Limova authentifiée et API accessible', 'DIAGNOSTIC_LIMOVA_SESSION_OK');
  } catch (error) {
    const login = error?.code === 'LIMOVA_LOGIN_REQUIRED';
    add('limovaSession', 'error', login ? 'Connecte-toi dans l’app Limova' : 'Session ou API Limova indisponible',
      login ? 'DIAGNOSTIC_LIMOVA_LOGIN_REQUIRED' : 'DIAGNOSTIC_LIMOVA_API_UNAVAILABLE');
    return checks;
  }
  if (!selection?.workspaceId) {
    add('limovaWorkspace', 'error', 'Sélectionne un espace Limova activé dans le panneau', 'DIAGNOSTIC_LIMOVA_WORKSPACE_REQUIRED');
    return checks;
  }
  if (selection.userId !== current.user.id) {
    add('limovaWorkspace', 'error', 'Le compte Limova a changé ; actualise la session du panneau', 'DIAGNOSTIC_LIMOVA_ACCOUNT_CHANGED');
    return checks;
  }
  const workspace = current.workspaces.find(item => item.id === selection.workspaceId);
  if (!workspace?.enabled) {
    add('limovaWorkspace', 'error', 'Cet espace est inaccessible ou l’extension y est désactivée', 'DIAGNOSTIC_LIMOVA_WORKSPACE_DISABLED');
    return checks;
  }
  add('limovaWorkspace', 'ok', 'Espace accessible et flag extension activé', 'DIAGNOSTIC_LIMOVA_WORKSPACE_OK');
  try {
    await client.getMainAgent(selection, signal);
    add('limovaAgent', 'ok', 'Agent principal Charly disponible', 'DIAGNOSTIC_LIMOVA_AGENT_OK');
  } catch {
    add('limovaAgent', 'error', 'Agent principal Charly indisponible ou accès modifié', 'DIAGNOSTIC_LIMOVA_AGENT_UNAVAILABLE');
    return checks;
  }
  if (selection.conversationId) {
    try {
      await client.getConversation(selection, selection.conversationId, signal);
      add('limovaConversation', 'ok', 'Conversation Deep Agent accessible', 'DIAGNOSTIC_LIMOVA_CONVERSATION_OK');
    } catch {
      add('limovaConversation', 'error', 'Conversation Deep Agent inaccessible ou session modifiée', 'DIAGNOSTIC_LIMOVA_CONVERSATION_UNAVAILABLE');
    }
  } else add('limovaConversation', 'info', 'Aucune conversation sélectionnée ; aucune créée par le diagnostic', 'DIAGNOSTIC_LIMOVA_CONVERSATION_NOT_SELECTED');
  add('deepAgentExecution', 'info', 'Modèle, mémoire, intégrations, MCP et LangSmith non exécutés par ce diagnostic', 'DIAGNOSTIC_DEEP_AGENT_NOT_EXECUTED');
  return checks;
}
