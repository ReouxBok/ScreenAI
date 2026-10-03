import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, SYSTEM_PROMPT_TEMPLATE } from '../../../src/prompts/system-prompt.js';
import { createOnboardingPlan } from '../../../src/prompts/onboarding-plan.js';

describe('buildSystemPrompt', () => {
  it('exposes a raw template with every placeholder', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('{LANG_NAME}');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('{PAGE_CONTEXT}');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('{CONSOLE_LOGS}');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('{ONBOARDING_DOCS}');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('{TRIGGER_INSTRUCTION}');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('{ONBOARDING_TEMPLATE_RULES}');
  });

  it('replaces every {LANG_NAME} occurrence', () => {
    const out = buildSystemPrompt({ lang: 'fr' });
    expect(out).not.toContain('{LANG_NAME}');
    expect(out).toContain('French');
  });

  it('maps known language codes to full names', () => {
    expect(buildSystemPrompt({ lang: 'fr' })).toContain('French');
    expect(buildSystemPrompt({ lang: 'es' })).toContain('Spanish');
    expect(buildSystemPrompt({ lang: 'de' })).toContain('German');
    expect(buildSystemPrompt({ lang: 'ja' })).toContain('Japanese');
  });

  it('falls back to English for unknown language codes', () => {
    const out = buildSystemPrompt({ lang: 'xx' });
    expect(out).toContain('English');
  });

  it('substitutes page context, console logs and docs', () => {
    const out = buildSystemPrompt({
      lang: 'en',
      pageContext: 'PAGE XXX',
      consoleLogs: 'LOG YYY',
      onboardingDocs: 'DOCS ZZZ',
      trigger: 'url_change'
    });
    expect(out).toContain('PAGE XXX');
    expect(out).toContain('LOG YYY');
    expect(out).toContain('DOCS ZZZ');
    expect(out).not.toContain('{PAGE_CONTEXT}');
    expect(out).not.toContain('{CONSOLE_LOGS}');
    expect(out).not.toContain('{ONBOARDING_DOCS}');
    expect(out).not.toContain('{TRIGGER_INSTRUCTION}');
  });

  it('uses the doc_load trigger copy for first interaction', () => {
    const out = buildSystemPrompt({ trigger: 'doc_load', lang: 'en', onboardingPlan: createOnboardingPlan() });
    expect(out).toContain('Trigger: doc_load');
    expect(out).toContain('Phase 1 - Setup');
    expect(out).toContain('Pour commencer, que faites-vous ?');
    expect(out).toContain('outils déjà utilisés');
    expect(out).toContain('do not present features, a checklist or several questions');
  });

  it('discovers the profession before recommending a limited set of use cases', () => {
    const out = buildSystemPrompt({ trigger: 'doc_load', lang: 'fr', onboardingPlan: createOnboardingPlan() });
    expect(out).toContain('deux à quatre activations concrètes');
    expect(out).toContain('agent Limova autonome');
    expect(out).toContain('produis un vrai output');
    expect(out).toContain('jamais un prérequis ni la première question obligatoire');
    expect(out).toContain("inspecte uniquement l'existant lié à ce résultat");
    expect(out).toContain('jamais un questionnaire');
    expect(out).toContain('Ask one question per turn');
  });

  it('treats the published template as adaptable guidance', () => {
    const out = buildSystemPrompt({ trigger: 'doc_load', lang: 'fr', onboardingPlan: createOnboardingPlan() });
    expect(out).toContain('never a checklist');
    expect(out).toContain('Select only relevant activation types');
    expect(out).toContain('Never force an example that does not fit the activity');
    expect(out).toContain('Keep this audit scoped to the current result');
    expect(out).toContain('never recreate an item unnecessarily');
    expect(out).toContain('test on a real example');
  });

  it('uses a generic trigger block for url_change', () => {
    const out = buildSystemPrompt({ trigger: 'url_change', lang: 'en' });
    expect(out).toContain('Trigger: url_change');
    expect(out).toContain('Phase 2 - Installation');
  });

  it('adds the modal-specific hint for modal_detected trigger', () => {
    const out = buildSystemPrompt({ trigger: 'modal_detected', lang: 'en' });
    expect(out).toContain('A modal or popup appeared');
  });

  it('injects the active onboarding plan with current step', () => {
    const plan = {
      revision: 'onboarding_v3',
      openingPrompt: 'Demande son objectif.',
      fallbackPrompt: 'Propose un point de départ adapté.',
      activeIndex: 1,
      steps: [
        { name: 'Accueil', status: 'completed', depth: 0 },
        { name: 'Intégrations', status: 'active', depth: 0, trigger: 'le membre veut connecter ses outils', description: 'Connect email', completionHint: 'Emit when done' },
        { name: 'Gmail', status: 'pending', depth: 1, trigger: 'il utilise Gmail', description: 'Connect Gmail' },
        { name: 'Documents', status: 'pending', depth: 0 }
      ]
    };
    const out = buildSystemPrompt({ lang: 'fr', onboardingPlan: plan });
    expect(out).toContain('Intégrations');
    expect(out).toContain('Connect email');
    expect(out).toContain('{{STEP_COMPLETE}}');
    expect(out).toContain('Terminées : Accueil');
    expect(out).toContain('Restantes : Gmail, Documents');
    expect(out).toContain('onboarding_v3');
    expect(out).toContain('Branches disponibles');
  });

  it('produces a stable snapshot for a canonical context', () => {
    // Guardrail against accidental prompt drift — update with intent
    const out = buildSystemPrompt({
      lang: 'en',
      pageContext: '<<PAGE>>',
      consoleLogs: '<<LOGS>>',
      onboardingDocs: '<<DOCS>>',
      trigger: 'url_change'
    });
    expect(out).toMatchSnapshot();
  });
});
