// Follow the viewer's Homeroom theme (the bridge reports it), with the
// OS preference as the fallback outside Homeroom. Shared by every page
// this app serves: the app shell and the public share page both link
// this file right after the bridge tag, so both switch looks live.
(function () {
  var media = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    var theme = (window.usernode && window.usernode.theme) || (media.matches ? 'dark' : 'light');
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
  }
  applyTheme();
  window.addEventListener('usernode:theme-changed', applyTheme);
  media.addEventListener('change', applyTheme);
})();
