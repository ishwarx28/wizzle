export type ThemePreference = "system" | "light" | "dark";
export type EffectiveTheme = "light" | "dark";

const THEME_STORAGE_KEY = "wizzle-theme-preference";
const THEME_CHANGE_EVENT = "wizzle:theme-change";

function getMediaQuery() {
  return window.matchMedia("(prefers-color-scheme: dark)");
}

export function getStoredThemePreference(): ThemePreference {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);

  if (stored === "light" || stored === "dark" || stored === "system") {
    return stored;
  }

  return "system";
}

export function resolveEffectiveTheme(preference: ThemePreference): EffectiveTheme {
  if (preference === "system") {
    return getMediaQuery().matches ? "dark" : "light";
  }

  return preference;
}

function dispatchThemeChange(preference: ThemePreference) {
  window.dispatchEvent(
    new CustomEvent(THEME_CHANGE_EVENT, {
      detail: {
        preference,
        effectiveTheme: resolveEffectiveTheme(preference),
      },
    }),
  );
}

function syncDocumentTheme(preference: ThemePreference) {
  const effectiveTheme = resolveEffectiveTheme(preference);

  document.documentElement.dataset.theme = preference;
  document.documentElement.dataset.effectiveTheme = effectiveTheme;
  document.documentElement.style.colorScheme = effectiveTheme;
}

let isSystemThemeListenerRegistered = false;

export function initializeThemePreference() {
  const preference = getStoredThemePreference();
  syncDocumentTheme(preference);

  if (!isSystemThemeListenerRegistered) {
    getMediaQuery().addEventListener("change", () => {
      const currentPreference = getStoredThemePreference();

      if (currentPreference !== "system") {
        return;
      }

      syncDocumentTheme(currentPreference);
      dispatchThemeChange(currentPreference);
    });
    isSystemThemeListenerRegistered = true;
  }
}

export function applyThemePreference(preference: ThemePreference) {
  window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  syncDocumentTheme(preference);
  dispatchThemeChange(preference);
}

export function getThemeChangeEventName() {
  return THEME_CHANGE_EVENT;
}
