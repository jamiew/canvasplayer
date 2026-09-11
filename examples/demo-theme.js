// Apply before styles to avoid flashing the wrong theme.
(function () {
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');
  let button;

  // Storage access can throw in private browsing.
  function savedTheme() {
    try { return localStorage.getItem('theme'); } catch (e) { return null; }
  }

  let preference = savedTheme();
  function applyTheme() {
    const dark = preference ? preference === 'dark' : system.matches;
    root.dataset.theme = dark ? 'dark' : 'light';
    if (button) button.setAttribute('aria-label', 'Switch to ' + (dark ? 'light' : 'dark') + ' theme');
  }
  applyTheme();

  document.addEventListener('DOMContentLoaded', () => {
    button = document.getElementById('theme');
    applyTheme();
    if (button) button.addEventListener('click', () => {
      preference = root.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme();
      try { localStorage.setItem('theme', preference); } catch (e) {}
    });
  }, { once: true });

  // Follow the system until the user chooses a theme.
  system.addEventListener('change', () => {
    if (!preference) applyTheme();
  });

  // Share the preference across same-origin frames and tabs.
  window.addEventListener('storage', event => {
    if (event.key !== 'theme' && event.key !== null) return;
    preference = savedTheme();
    applyTheme();
  });
}());
