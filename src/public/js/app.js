// DOGFOOD 2026 — Master Client Script & Progressive Interactivity

document.addEventListener('DOMContentLoaded', () => {
  // 1. Toast Notification System
  window.showToast = function(message, type = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type === 'error' ? 'toast-error' : type === 'success' ? 'toast-success' : ''}`;
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(8px)';
      setTimeout(() => toast.remove(), 250);
    }, 3200);
  };

  // 2. Active Navigation Item Highlight
  const currentPath = window.location.pathname;
  const navLinks = document.querySelectorAll('.main-nav .nav-link');
  navLinks.forEach((link) => {
    const linkPath = link.getAttribute('data-path');
    if (linkPath) {
      if (currentPath === linkPath || (linkPath !== '/' && currentPath.startsWith(linkPath))) {
        link.classList.add('active');
      } else {
        link.classList.remove('active');
      }
    }
  });

  // 3. Dropdowns (Profile & Demo)
  const profileBtn = document.getElementById('profile-dropdown-btn');
  const profileDropdown = document.getElementById('profile-dropdown-content');

  if (profileBtn && profileDropdown) {
    profileBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      profileDropdown.classList.toggle('show');
      profileBtn.classList.toggle('open');
    });
  }

  const demoBtn = document.getElementById('demo-dropdown-btn');
  const demoDropdown = document.getElementById('demo-dropdown-content');

  if (demoBtn && demoDropdown) {
    demoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      demoDropdown.classList.toggle('show');
    });
  }

  document.addEventListener('click', (e) => {
    if (profileDropdown && !profileDropdown.contains(e.target) && !profileBtn.contains(e.target)) {
      profileDropdown.classList.remove('show');
      if (profileBtn) profileBtn.classList.remove('open');
    }
    if (demoDropdown && !demoDropdown.contains(e.target) && !demoBtn.contains(e.target)) {
      demoDropdown.classList.remove('show');
    }
  });

  // 4. Live Search & Track Filter
  const searchInput = document.getElementById('gallery-search');
  const trackFilter = document.getElementById('gallery-track');
  const trackPillButtons = document.querySelectorAll('.track-pill-btn');
  const projectCards = document.querySelectorAll('.grid-cards .project-card');
  const noProjectsBanner = document.getElementById('no-projects-banner');
  const clearFiltersBtn = document.getElementById('btn-clear-filters');

  function filterProjects() {
    if (!projectCards.length) return;
    const query = searchInput ? searchInput.value.toLowerCase().trim() : '';
    const track = trackFilter ? trackFilter.value : '';

    let visibleCount = 0;
    projectCards.forEach((card) => {
      const title = card.getAttribute('data-title') || '';
      const summary = card.getAttribute('data-summary') || '';
      const cardTrack = card.getAttribute('data-track') || '';

      const matchesSearch = !query || title.includes(query) || summary.includes(query);
      const matchesTrack = !track || cardTrack === track;

      if (matchesSearch && matchesTrack) {
        card.style.display = '';
        visibleCount++;
      } else {
        card.style.display = 'none';
      }
    });

    if (noProjectsBanner) {
      noProjectsBanner.style.display = visibleCount === 0 ? 'block' : 'none';
    }
  }

  if (searchInput) {
    searchInput.addEventListener('input', filterProjects);
  }

  // Keyboard shortcut '/' to focus search input
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== searchInput && searchInput) {
      e.preventDefault();
      searchInput.focus();
    }
  });

  // Track Pill Click Handlers
  trackPillButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const selectedTrack = btn.getAttribute('data-track-id') || '';
      trackPillButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      if (trackFilter) {
        trackFilter.value = selectedTrack;
      }
      filterProjects();
    });
  });

  if (trackFilter) {
    trackFilter.addEventListener('change', () => {
      const val = trackFilter.value;
      trackPillButtons.forEach(b => {
        b.classList.toggle('active', (b.getAttribute('data-track-id') || '') === val);
      });
      filterProjects();
    });
  }

  if (clearFiltersBtn) {
    clearFiltersBtn.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      if (trackFilter) trackFilter.value = '';
      trackPillButtons.forEach((b, i) => b.classList.toggle('active', i === 0));
      filterProjects();
    });
  }
});
