/*
  STELLAR PANEL THEME SYSTEM
  ==========================
  Persistable dark mode with three modes: 'light' | 'dark' | 'system'.
  'system' tracks the OS preference via prefers-color-scheme and updates live.

  Mechanism:
  - Mode is saved to localStorage key 'votion_theme'.
  - The resolved effective theme ('light' | 'dark') is applied as
    data-theme="dark" on <html>, which switches the CSS variable layer
    (see src/index.css + styles.css [data-theme="dark"] blocks).
  - A storage event listener across tabs keeps all open tabs in sync.
*/

export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'votion_theme';
const ATTR = 'data-theme';

/** Resolve the effective theme from a mode, honoring the OS preference. */
function resolve(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

/** Apply the resolved theme to <html> (synchronous, works before React mounts). */
function applyTheme(mode: ThemeMode) {
  const effective = resolve(mode);
  const html = document.documentElement;
  if (effective === 'dark') {
    html.setAttribute(ATTR, 'dark');
  } else {
    html.removeAttribute(ATTR);
  }
}

/** Read the saved mode (or default to 'system'). */
export function getStoredThemeMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {}
  return 'system';
}

/** Save a mode and apply it immediately. */
export function setThemeMode(mode: ThemeMode) {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {}
  applyTheme(mode);
}

/** Synchronous bootstrap: call this once before React mounts to eliminate FOUC. */
export function initTheme() {
  const mode = getStoredThemeMode();
  applyTheme(mode);
  if (mode === 'system' && typeof window !== 'undefined' && window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      applyTheme('system');
    });
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_KEY && e.newValue !== null) {
        applyTheme(getStoredThemeMode());
      }
    });
  }
}
