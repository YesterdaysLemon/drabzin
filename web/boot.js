// Runs before the page draws: the theme and writing direction chosen last time, so the page
// does not flash light-then-dark or left-then-right. app.js fills in the words.
try {
  const root = document.documentElement;
  const theme = localStorage.getItem('drabzin.theme');
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  const lang = localStorage.getItem('drabzin.lang') || (navigator.language || 'en').toLowerCase().split('-')[0];
  if (['fa', 'ar', 'ur', 'hi'].includes(lang)) {
    root.lang = lang;
    root.dir = lang === 'hi' ? 'ltr' : 'rtl';
    root.dataset.pending = '';   // style.css keeps the page hidden (at most a moment) until the words arrive
  }
} catch { /* storage blocked: defaults */ }
