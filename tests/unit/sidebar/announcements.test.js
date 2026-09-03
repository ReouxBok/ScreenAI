// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { loadSidebarScript } from '../../helpers/load-script.js';

describe('sidebar/announcements.js', () => {
  let mod;

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="quickLinks"></div>
      <div id="headerMenu" hidden></div>
      <button id="linksBtn"></button>
      <div id="newsModalBackdrop" hidden>
        <div class="news-modal-header"><h3></h3></div>
        <div id="newsModalBody"></div>
        <button id="newsModalClose"></button>
      </div>
    `;
    mod = loadSidebarScript('src/sidebar/announcements.js');
  });

  describe('ANNOUNCEMENTS_DATA', () => {
    it('exposes only the quick links collection', () => {
      expect(Array.isArray(mod.ANNOUNCEMENTS_DATA.quickLinks)).toBe(true);
      expect(mod.ANNOUNCEMENTS_DATA.news).toBeUndefined();
    });

    it('quick link entries have label and icon', () => {
      for (const link of mod.ANNOUNCEMENTS_DATA.quickLinks) {
        expect(link).toHaveProperty('label');
        expect(link).toHaveProperty('icon');
        expect(link).toHaveProperty('url');
      }
    });

    it('uses the approved webinar registration URL', () => {
      const webinar = mod.ANNOUNCEMENTS_DATA.quickLinks.find(link => /webinaire/i.test(link.label));
      expect(webinar?.url).toBe('https://bienvenue.limova.ai/');
    });

    it('contains no Nouveautés entry and no button-only item', () => {
      expect(mod.ANNOUNCEMENTS_DATA.quickLinks.some(link => /nouveaut/i.test(link.label))).toBe(false);
      expect(mod.ANNOUNCEMENTS_DATA.quickLinks.every(link => Boolean(link.url))).toBe(true);
    });
  });

  describe('buildQuickLinksDOM', () => {
    it('renders an <a> element for links with URL', () => {
      const dom = mod.buildQuickLinksDOM();
      const anchors = dom.querySelectorAll('a.quick-link-item');
      const buttons = dom.querySelectorAll('button.quick-link-item');
      expect(anchors.length).toBe(mod.ANNOUNCEMENTS_DATA.quickLinks.length);
      expect(buttons.length).toBe(0);
    });

    it('external anchors have rel="noopener noreferrer" and target=_blank', () => {
      const dom = mod.buildQuickLinksDOM();
      dom.querySelectorAll('a.quick-link-item').forEach(a => {
        expect(a.target).toBe('_blank');
        expect(a.rel).toBe('noopener noreferrer');
      });
    });

    it('each item has an icon, label and arrow SVG', () => {
      const dom = mod.buildQuickLinksDOM();
      dom.querySelectorAll('.quick-link-item').forEach(item => {
        expect(item.querySelector('.quick-link-icon')).toBeTruthy();
        expect(item.querySelector('.quick-link-label')).toBeTruthy();
        expect(item.querySelector('svg.quick-link-arrow')).toBeTruthy();
      });
    });
  });

  describe('renderAnnouncements', () => {
    it('injects quick links into #quickLinks', () => {
      mod.renderAnnouncements();
      const container = document.getElementById('quickLinks');
      expect(container.querySelectorAll('.quick-link-item').length).toBeGreaterThan(0);
    });
  });

  describe('modal open/close', () => {
    it('openModal reveals the backdrop with title and body', () => {
      const body = document.createElement('span');
      body.textContent = 'hello';
      mod.openModal('Test', body);
      const backdrop = document.getElementById('newsModalBackdrop');
      expect(backdrop.hidden).toBe(false);
      expect(backdrop.querySelector('h3').textContent).toBe('Test');
      expect(document.getElementById('newsModalBody').textContent).toBe('hello');
    });

    it('closeModal hides the backdrop', () => {
      mod.openModal('X', document.createElement('div'));
      mod.closeModal();
      expect(document.getElementById('newsModalBackdrop').hidden).toBe(true);
    });
  });
});
