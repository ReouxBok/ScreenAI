/**
 * Announcements & Quick Links — edit arrays below to update content.
 * No code changes needed elsewhere.
 */

const ANNOUNCEMENTS_DATA = {
  news: [
    {
      date: '26 mars 2026',
      title: 'Charly parle maintenant !',
      text: 'Active le mode vocal pour parler directement avec Charly.'
    }
  ],
  quickLinks: [
    {
      label: 'Inscription Webinaire',
      url: 'https://zoom.us/webinar/register', // TODO: replace with actual Zoom link
      icon: '🎓'
    },
    {
      label: 'Academy Limova',
      url: 'https://academy.limova.ai', // TODO: replace with actual URL
      icon: '📚'
    }
  ]
};

function renderAnnouncements() {
  // Welcome screen quick links
  const linksContainer = document.getElementById('quickLinks');
  if (linksContainer) linksContainer.innerHTML = buildQuickLinksHTML();

  // Header menu buttons
  const headerMenu = document.getElementById('headerMenu');
  const newsBtn = document.getElementById('newsBtn');
  const linksBtn = document.getElementById('linksBtn');

  if (newsBtn) newsBtn.addEventListener('click', () => {
    if (headerMenu) headerMenu.hidden = true;
    openModal('Nouveautés', buildNewsModalHTML());
  });
  if (linksBtn) linksBtn.addEventListener('click', () => {
    if (headerMenu) headerMenu.hidden = true;
    openModal('Liens rapides', buildQuickLinksHTML());
  });

  // Modal close
  const modalClose = document.getElementById('newsModalClose');
  const modalBackdrop = document.getElementById('newsModalBackdrop');
  if (modalClose) modalClose.addEventListener('click', closeModal);
  if (modalBackdrop) modalBackdrop.addEventListener('click', (e) => {
    if (e.target === modalBackdrop) closeModal();
  });
}

function openModal(title, bodyHTML) {
  const backdrop = document.getElementById('newsModalBackdrop');
  const body = document.getElementById('newsModalBody');
  const headerTitle = backdrop?.querySelector('.news-modal-header h3');
  if (!backdrop || !body) return;

  if (headerTitle) headerTitle.textContent = title;
  body.innerHTML = bodyHTML;
  backdrop.hidden = false;
}

function closeModal() {
  const backdrop = document.getElementById('newsModalBackdrop');
  if (backdrop) backdrop.hidden = true;
}

function buildNewsModalHTML() {
  return ANNOUNCEMENTS_DATA.news.map(item => `
    <div class="news-item">
      <span class="news-date">${item.date}</span>
      <span class="news-title">${item.title}</span>
      <span class="news-text">${item.text}</span>
    </div>
  `).join('');
}

function buildQuickLinksHTML() {
  if (!ANNOUNCEMENTS_DATA.quickLinks.length) return '';
  return `
    <div class="quick-links-list">
      ${ANNOUNCEMENTS_DATA.quickLinks.map(link => `
        <a href="${link.url}" target="_blank" rel="noopener" class="quick-link-item">
          <span class="quick-link-icon">${link.icon}</span>
          <span class="quick-link-label">${link.label}</span>
          <svg class="quick-link-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17l9.2-9.2M17 17V7H7"/></svg>
        </a>
      `).join('')}
    </div>
  `;
}
