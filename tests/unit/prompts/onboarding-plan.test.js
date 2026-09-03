import { describe, it, expect } from 'vitest';
import { createOnboardingPlan, advanceStep } from '../../../src/prompts/onboarding-plan.js';

describe('createOnboardingPlan', () => {
  it('returns a fresh intent-first plan with 7 steps and activeIndex=0', () => {
    const plan = createOnboardingPlan();
    expect(plan.steps).toHaveLength(7);
    expect(plan.activeIndex).toBe(0);
    expect(typeof plan.startedAt).toBe('number');
  });

  it('first step is active, rest are pending', () => {
    const plan = createOnboardingPlan();
    expect(plan.steps[0].status).toBe('active');
    for (let i = 1; i < plan.steps.length; i++) {
      expect(plan.steps[i].status).toBe('pending');
    }
  });

  it('deep-copies steps so mutating one plan does not affect the next', () => {
    const p1 = createOnboardingPlan();
    p1.steps[0].status = 'completed';
    const p2 = createOnboardingPlan();
    expect(p2.steps[0].status).toBe('active');
  });

  it('each step declares the required shape', () => {
    for (const step of createOnboardingPlan().steps) {
      expect(step).toHaveProperty('id');
      expect(step).toHaveProperty('name');
      expect(step).toHaveProperty('type');
      expect(step).toHaveProperty('description');
      expect(step).toHaveProperty('completionHint');
      expect(Array.isArray(step.expectedUrls)).toBe(true);
      expect(Array.isArray(step.kbQueries)).toBe(true);
    }
  });

  it('step ids are unique', () => {
    const ids = createOnboardingPlan().steps.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('starts with goal discovery before the canonical product tour', () => {
    const expected = [
      'orientation-besoins',
      'decouverte-accueil',
      'integrations',
      'charly-plus-compte',
      'documents-contexte',
      'guidelines-email-agenda',
      'super-pouvoirs'
    ];
    expect(createOnboardingPlan().steps.map(s => s.id)).toEqual(expected);
  });

  it('defines the progressive discovery funnel and exact super-power names', () => {
    const orientation = createOnboardingPlan().steps[0].description;
    expect(orientation).toContain('Est-ce qu\'il y a un sujet en particulier que tu veux traiter aujourd\'hui ?');
    expect(orientation).toContain('Créer une campagne de prospection LinkedIn');
    expect(orientation).toContain('Créer une campagne de posts pour réseaux sociaux');
    expect(orientation.indexOf('Qu\'est-ce que tu fais dans la vie ?'))
      .toBeGreaterThan(orientation.indexOf('Créer une campagne de posts pour réseaux sociaux'));
    expect(orientation).toContain('au maximum deux cas d\'usage concrets');
  });

  it('builds a published Studio hierarchy', () => {
    const plan = createOnboardingPlan({
      revision: 'onboarding_v4',
      name: 'Trame équipe',
      openingPrompt: 'Demande son objectif.',
      fallbackPrompt: 'Propose deux idées.',
      steps: [
        { id: 'start', name: 'Commencer', depth: 0, trigger: 'toujours', description: 'Départ', expectedUrls: [], kbQueries: [] },
        { id: 'branch', name: 'Branche Gmail', depth: 1, trigger: 'si Gmail', description: 'Gmail', expectedUrls: ['/integrations'], kbQueries: ['gmail'] },
        { id: 'finish', name: 'Finaliser', depth: 0, trigger: 'après le départ', description: 'Fin', expectedUrls: [], kbQueries: [] }
      ]
    });
    expect(plan.revision).toBe('onboarding_v4');
    expect(plan.steps[1]).toMatchObject({ depth: 1, trigger: 'si Gmail' });
  });
});

describe('advanceStep', () => {
  it('marks current step completed and activates the next', () => {
    const plan = createOnboardingPlan();
    const updated = advanceStep(plan);
    expect(updated).not.toBeNull();
    expect(updated.activeIndex).toBe(1);
    expect(updated.steps[0].status).toBe('completed');
    expect(updated.steps[1].status).toBe('active');
  });

  it('skips conditional branches when advancing the main thread', () => {
    const plan = createOnboardingPlan({
      steps: [
        { id: 'start', name: 'Commencer', depth: 0 },
        { id: 'branch', name: 'Branche', depth: 1 },
        { id: 'next', name: 'Suite', depth: 0 }
      ]
    });
    const updated = advanceStep(plan);
    expect(updated.activeIndex).toBe(2);
    expect(updated.steps[2].status).toBe('active');
  });

  it('returns null when advancing past the last step', () => {
    const plan = createOnboardingPlan();
    plan.activeIndex = plan.steps.length - 1;
    plan.steps[plan.activeIndex].status = 'active';
    const result = advanceStep(plan);
    expect(result).toBeNull();
    // Last step is still marked completed though
    expect(plan.steps.at(-1).status).toBe('completed');
  });

  it('mutates the provided plan (in-place update)', () => {
    const plan = createOnboardingPlan();
    const ref = advanceStep(plan);
    expect(ref).toBe(plan);
  });

  it('walks through all steps end-to-end without losing state', () => {
    const plan = createOnboardingPlan();
    let current = plan;
    const visited = [];
    while (current) {
      visited.push(current.steps[current.activeIndex].id);
      current = advanceStep(plan);
    }
    expect(visited).toHaveLength(7);
    expect(plan.steps.every(s => s.status === 'completed')).toBe(true);
  });
});
