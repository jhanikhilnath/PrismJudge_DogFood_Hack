/**
 * DOGFOOD 2026 Standalone Embeddable Gallery Widget Loader
 * Zero dependencies. Embeds interactive project showcases on any host website.
 *
 * Usage:
 *   <div class="dogfood-widget" data-track="all" data-limit="3"></div>
 *   <script src="http://localhost:8080/static/js/widget.js" async></script>
 */
(function () {
  'use strict';

  function initWidgets() {
    var containers = document.querySelectorAll('.dogfood-widget:not([data-initialized])');
    if (!containers || containers.length === 0) return;

    var scriptTag = document.currentScript || document.querySelector('script[src*="widget.js"]');
    var baseUrl = '';
    if (scriptTag && scriptTag.src) {
      var urlObj = new URL(scriptTag.src);
      baseUrl = urlObj.origin;
    } else {
      baseUrl = window.location.origin;
    }

    containers.forEach(function (container) {
      container.setAttribute('data-initialized', 'true');
      var track = container.getAttribute('data-track') || 'all';
      var theme = container.getAttribute('data-theme') || 'light';
      var height = container.getAttribute('data-height') || '480px';

      var iframe = document.createElement('iframe');
      var src = baseUrl + '/embed/gallery';
      var params = [];
      if (track && track !== 'all') params.push('track=' + encodeURIComponent(track));
      if (theme) params.push('theme=' + encodeURIComponent(theme));
      if (params.length > 0) src += '?' + params.join('&');

      iframe.src = src;
      iframe.style.width = '100%';
      iframe.style.height = height;
      iframe.style.border = '1px solid #E2E8F0';
      iframe.style.borderRadius = '12px';
      iframe.style.boxShadow = '0 4px 6px -1px rgba(0, 0, 0, 0.05)';
      iframe.style.overflow = 'hidden';
      iframe.title = 'DOGFOOD 2026 Hackathon Gallery Showcase';
      iframe.setAttribute('loading', 'lazy');

      container.innerHTML = '';
      container.appendChild(iframe);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWidgets);
  } else {
    initWidgets();
  }

  window.DogfoodWidget = {
    reload: initWidgets,
  };
})();
