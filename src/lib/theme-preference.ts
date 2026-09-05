export type ThemePreference = "system" | "light" | "dark";

export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface ThemeClassList {
  add(className: string): void;
  remove?(className: string): void;
  delete?(className: string): boolean;
}

export function normalizeThemePreference(
  value: string | null,
): ThemePreference {
  if (value === "light" || value === "dark" || value === "system") {
    return value;
  }

  return "system";
}

export function readStoredThemePreference(
  storage: ThemeStorage | undefined,
): ThemePreference {
  if (!storage) {
    return "system";
  }

  try {
    return normalizeThemePreference(storage.getItem("theme"));
  } catch {
    return "system";
  }
}

export function writeStoredThemePreference(
  preference: ThemePreference,
  storage: ThemeStorage | undefined,
) {
  if (!storage) {
    return;
  }

  try {
    if (preference === "system") {
      storage.removeItem("theme");
    } else {
      storage.setItem("theme", preference);
    }
  } catch {
    // Storage is cosmetic; never break sign-in when a browser restricts it.
  }
}

export function shouldUseDarkMode(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): boolean {
  if (preference === "dark") {
    return true;
  }

  if (preference === "light") {
    return false;
  }

  return systemPrefersDark;
}

export function applyThemePreference({
  preference,
  root,
  systemPrefersDark,
}: {
  preference: ThemePreference;
  root: ThemeClassList;
  systemPrefersDark: boolean;
}) {
  if (shouldUseDarkMode(preference, systemPrefersDark)) {
    root.add("dark");
    return;
  }

  if (root.remove) {
    root.remove("dark");
    return;
  }

  root.delete?.("dark");
}
