// DOGFOOD 2026 — Progressive Enhancement & Interactivity

document.addEventListener('DOMContentLoaded', () => {
  // 1. Highlight Active Navigation Item based on current path
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

  // 2. Profile & Demo Dropdown Handlers
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

  // Close dropdowns on outside click
  document.addEventListener('click', (e) => {
    if (profileDropdown && !profileDropdown.contains(e.target) && !profileBtn.contains(e.target)) {
      profileDropdown.classList.remove('show');
      if (profileBtn) profileBtn.classList.remove('open');
    }
    if (demoDropdown && !demoDropdown.contains(e.target) && !demoBtn.contains(e.target)) {
      demoDropdown.classList.remove('show');
    }
  });

  // 3. Live Gallery Search & Track Filter
  const searchInput = document.getElementById('gallery-search');
  const trackFilter = document.getElementById('gallery-track');
  const projectCards = document.querySelectorAll('.project-card');

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

    const noProjectsBanner = document.getElementById('no-projects-banner');
    if (noProjectsBanner) {
      noProjectsBanner.style.display = visibleCount === 0 ? 'block' : 'none';
    }
  }

  if (searchInput) searchInput.addEventListener('input', filterProjects);
  if (trackFilter) trackFilter.addEventListener('change', filterProjects);

  // 4. Dynamic Rubric Score Calculator for Judge Modal
  const rubricInputs = document.querySelectorAll('.rubric-input');
  const scoreTotalDisplay = document.getElementById('computed-raw-total');

  function updateScoreTotal() {
    if (!rubricInputs.length || !scoreTotalDisplay) return;
    let total = 0;
    rubricInputs.forEach((input) => {
      const weight = parseFloat(input.getAttribute('data-weight') || '0.33');
      const val = parseFloat(input.value || '0');
      total += val * weight;
    });
    scoreTotalDisplay.textContent = total.toFixed(2);
  }

  rubricInputs.forEach((input) => {
    input.addEventListener('input', updateScoreTotal);
  });
});
