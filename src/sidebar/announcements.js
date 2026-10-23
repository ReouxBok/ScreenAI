/** Quick Links — edit the array below to update destinations. */

const ANNOUNCEMENTS_DATA = {
  quickLinks: [
    {
      id: 'webinar',
      label: 'Inscription Webinaire',
      url: 'https://bienvenue.limova.ai/',
      icon: '\u{1F393}'
    },
    {
      id: 'academy',
      label: 'Academy Limova',
      url: 'https://academy.limova.ai',
      icon: '\u{1F4DA}'
    }
  ]
};

function renderAnnouncements() {
  // Welcome screen quick links
  const linksContainer = document.getElementById('quickLinks');
  if (linksContainer) {
    linksContainer.textContent = '';
    linksContainer.appendChild(buildQuickLinksDOM('welcome'));
  }

  // Header menu button
  const headerMenu = document.getElementById('headerMenu');
  const linksBtn = document.getElementById('linksBtn');

  if (linksBtn) linksBtn.addEventListener('click', () => {
    if (headerMenu) headerMenu.hidden = true;
    chrome.runtime.sendMessage({ type: 'TRACK_EVENT', event: 'ui_clicked', properties: { target: 'quick_links' } }).catch(() => {});
    openModal('Liens rapides', buildQuickLinksDOM('menu'));
  });

  // Modal close
  const modalClose = document.getElementById('newsModalClose');
  const modalBackdrop = document.getElementById('newsModalBackdrop');
  if (modalClose) modalClose.addEventListener('click', closeModal);
  if (modalBackdrop) modalBackdrop.addEventListener('click', (e) => {
    if (e.target === modalBackdrop) closeModal();
  });
}

function openModal(title, bodyDOM) {
  const backdrop = document.getElementById('newsModalBackdrop');
  const body = document.getElementById('newsModalBody');
  const headerTitle = backdrop?.querySelector('.news-modal-header h3');
  if (!backdrop || !body) return;

  if (headerTitle) headerTitle.textContent = title;
  body.textContent = '';
  body.appendChild(bodyDOM);
  backdrop.hidden = false;
}

function closeModal() {
  const backdrop = document.getElementById('newsModalBackdrop');
  if (backdrop) backdrop.hidden = true;
}

// UTM parameters let the webinar and Academy sites attribute sign-ups to Charly.
function quickLinkUrl(link, placement) {
  const url = new URL(link.url);
  url.searchParams.set('utm_source', 'charly');
  url.searchParams.set('utm_medium', 'extension');
  url.searchParams.set('utm_campaign', 'quick_link');
  url.searchParams.set('utm_content', placement);
  return url.toString();
}

function buildQuickLinksDOM(placement = 'welcome') {
  const container = document.createElement('div');
  if (!ANNOUNCEMENTS_DATA.quickLinks.length) return container;

  container.className = 'quick-links-list';
  for (const link of ANNOUNCEMENTS_DATA.quickLinks) {
    const a = document.createElement(link.url ? 'a' : 'button');
    if (link.url) {
      a.href = quickLinkUrl(link, placement);
      a.dataset.linkId = link.id;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    a.className = 'quick-link-item';

    const icon = document.createElement('span');
    icon.className = 'quick-link-icon';
    icon.textContent = link.icon;

    const label = document.createElement('span');
    label.className = 'quick-link-label';
    label.textContent = link.label;

    // Arrow SVG — static, safe to create via namespace
    const arrowSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrowSvg.setAttribute('class', 'quick-link-arrow');
    arrowSvg.setAttribute('width', '14');
    arrowSvg.setAttribute('height', '14');
    arrowSvg.setAttribute('viewBox', '0 0 24 24');
    arrowSvg.setAttribute('fill', 'none');
    arrowSvg.setAttribute('stroke', 'currentColor');
    arrowSvg.setAttribute('stroke-width', '2');
    const arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arrowPath.setAttribute('d', 'M7 17l9.2-9.2M17 17V7H7');
    arrowSvg.appendChild(arrowPath);

    a.append(icon, label, arrowSvg);
    container.appendChild(a);
  }
  return container;
}
