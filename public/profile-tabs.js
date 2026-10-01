// Profile page sections. Every card carries data-tabs="account shop people" (one or more names);
// only the cards for the chosen tab are shown. Cards stay in the page, so their own scripts keep working.
export const PROFILE_TABS = Object.freeze(['account', 'shop', 'people']);
const STORAGE_KEY = 'profile-tab';

export function bindProfileTabs({ document, storage = globalThis.sessionStorage }) {
  const buttons = [...document.querySelectorAll('[data-profile-tab]')];
  const items = [...document.querySelectorAll('[data-tabs]')];
  let current = PROFILE_TABS[0];

  function show(name, { focus = false } = {}) {
    if (!PROFILE_TABS.includes(name)) name = PROFILE_TABS[0];
    current = name;
    for (const item of items) item.classList.toggle('tab-off', !item.dataset.tabs.split(' ').includes(name));
    for (const button of buttons) {
      const on = button.dataset.profileTab === name;
      button.setAttribute('aria-selected', String(on));
      button.tabIndex = on ? 0 : -1;
      button.classList.toggle('active', on);
      if (on && focus) button.focus({ preventScroll: true });
    }
    try { storage?.setItem(STORAGE_KEY, name); } catch { /* storage may be unavailable */ }
    return name;
  }

  for (const button of buttons) {
    button.addEventListener('click', () => show(button.dataset.profileTab));
    button.addEventListener('keydown', event => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        show(PROFILE_TABS[event.key === 'Home' ? 0 : PROFILE_TABS.length - 1], { focus: true });
      } else if (step) {
        event.preventDefault();
        show(PROFILE_TABS[(PROFILE_TABS.indexOf(current) + step + PROFILE_TABS.length) % PROFILE_TABS.length], { focus: true });
      }
    });
  }

  let saved = null;
  try { saved = storage?.getItem(STORAGE_KEY); } catch { /* storage may be unavailable */ }
  show(saved);
  return { show, get current() { return current; } };
}
