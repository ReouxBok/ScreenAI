const { FunctionTool, LongRunningFunctionTool } = require('@google/adk');
const { z } = require('zod');
const { assertExtensionAgentIsolation } = require('./isolation');

const elementReference = {
  // Gemini function declarations accept `minimum`, but reject the
  // `exclusiveMinimum` emitted by Zod's `.positive()` helper.
  elementId: z.number().int().min(1).describe('Identifiant DOM fourni par la version courante du contexte.'),
  contextVersion: z.number().int().nonnegative().describe('Version exacte du contexte DOM contenant cet identifiant.')
};

function clientTool(name, description, parameters) {
  return new LongRunningFunctionTool({
    name,
    description,
    parameters,
    execute: async () => undefined
  });
}

function createCharlyTools({ searchKnowledge }) {
  const tools = [
    clientTool(
      'inspect_current_page',
      'Rafraîchit la structure DOM et les éléments interactifs de la page Limova active. À utiliser avant une action si le contexte est ancien ou incomplet.',
      z.object({ reason: z.string().max(240).optional() }).strict()
    ),
    clientTool(
      'capture_current_view',
      'Prend silencieusement une capture temporaire et masquée de la vue courante uniquement pour récupérer après une cible introuvable, ambiguë ou un résultat inattendu.',
      z.object({ reason: z.string().min(1).max(240) }).strict()
    ),
    clientTool(
      'click_element',
      'Clique un contrôle DOM exact. Pour envoyer, publier, supprimer ou confirmer, explicitRequest doit être vrai et la cible doit correspondre exactement à la demande du tour courant.',
      z.object({
        ...elementReference,
        targetLabel: z.string().min(1).max(300),
        explicitRequest: z.boolean()
      }).strict()
    ),
    clientTool(
      'fill_field',
      'Remplit le champ DOM exact avec le texte demandé. La valeur est éphémère et ne doit jamais être citée dans un souvenir ou un journal.',
      z.object({
        ...elementReference,
        targetLabel: z.string().min(1).max(300),
        text: z.string().max(8_000)
      }).strict()
    ),
    clientTool(
      'scroll_page',
      'Fait défiler la page Limova ou la zone contenant un élément afin de découvrir les contrôles hors écran. Relire ensuite le DOM avant toute action.',
      z.object({
        direction: z.enum(['up', 'down', 'top', 'bottom']),
        amount: z.enum(['small', 'medium', 'large']).default('medium'),
        contextVersion: z.number().int().nonnegative(),
        elementId: z.number().int().min(1).optional()
      }).strict()
    ),
    clientTool(
      'navigate_internal',
      'Navigue dans Limova en activant un élément DOM de navigation. Ne reçoit jamais une URL arbitraire.',
      z.object({
        ...elementReference,
        targetLabel: z.string().min(1).max(300)
      }).strict()
    ),
    clientTool(
      'verify_expected_result',
      'Vérifie localement la route, la modale et le DOM après une action avant d’annoncer sa réussite.',
      z.object({
        expectation: z.string().min(1).max(500),
        contextVersion: z.number().int().nonnegative()
      }).strict()
    ),
    new FunctionTool({
      name: 'search_knowledge_base',
      description: 'Recherche les articles et parcours publiés du Studio Charly correspondant à la question et à la page Limova.',
      parameters: z.object({
        query: z.string().min(2).max(2_000),
        path: z.string().max(1_000).default('/'),
        locale: z.enum(['fr-FR', 'en-US', 'es-ES']).default('fr-FR')
      }).strict(),
      execute: async input => searchKnowledge(input)
    })
  ];
  assertExtensionAgentIsolation(tools.map(tool => tool.name));
  return tools;
}

module.exports = { createCharlyTools };
