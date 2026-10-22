// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { loadSidebarScript } from '../../helpers/load-script.js';

describe('sidebar/site-access.js', () => {
  let mod;

  beforeAll(() => {
    mod = loadSidebarScript('src/sidebar/site-access.js');
  });

  it.each([
    'Fais-moi un post LinkedIn à partir de ce que tu vois sur l’écran',
    'Rédige une réponse à ce message',
    'écris un mail de relance à Thomas',
    'Résume cette page',
    'Prépare une newsletter avec ces infos',
    'Write a LinkedIn post about this profile',
    'Escribe un correo para este cliente'
  ])('sends “%s” to Limova', text => {
    expect(mod.isLimovaOutputRequest(text)).toBe(true);
  });

  it.each([
    'Fais défiler la page',
    'Clique sur Réseau',
    'Qu’est-ce que je vois sur cette page ?',
    'Ouvre mes notifications',
    'Make the page scroll down'
  ])('keeps “%s” on the page', text => {
    expect(mod.isLimovaOutputRequest(text)).toBe(false);
  });

  it('only offers access for web pages outside Limova', () => {
    expect(mod.siteOriginOf('https://www.linkedin.com/mynetwork/?x=1')).toBe('https://www.linkedin.com');
    expect(mod.siteOriginOf('https://new.limova.ai/chat/new')).toBeNull();
    expect(mod.siteOriginOf('chrome://extensions')).toBeNull();
    expect(mod.siteOriginOf(undefined)).toBeNull();
    expect(mod.siteLabelOf('https://www.linkedin.com')).toBe('linkedin.com');
  });
});
