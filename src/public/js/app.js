// Lightweight client-side progressive enhancement
document.addEventListener('DOMContentLoaded', () => {
  // Live gallery filter
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

  // Dynamic rubric score calculator
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
