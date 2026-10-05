// Runs in <head> before the page paints, so the saved or system colour scheme applies without a flash.
(function () {
  var root = document.documentElement;
  root.classList.add('js');
  var saved = null;
  try { saved = localStorage.getItem('welcome-theme'); } catch (error) { /* private mode: follow the system */ }
  var dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  root.classList.toggle('dark', dark);
})();
