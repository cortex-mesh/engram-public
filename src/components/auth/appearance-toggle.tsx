"use client";

import { useEffect, useSyncExternalStore } from "react";

import {
  applyThemePreference,
  readStoredThemePreference,
  type ThemePreference,
  writeStoredThemePreference,
} from "@/lib/theme-preference";

const THEME_CHANGE_EVENT = "engram-theme-preference-change";

const preferences: Array<{
  value: ThemePreference;
  label: string;
  ariaLabel: string;
}> = [
  { value: "system", label: "System", ariaLabel: "Use system appearance" },
  { value: "light", label: "Light", ariaLabel: "Use light appearance" },
  { value: "dark", label: "Dark", ariaLabel: "Use dark appearance" },
];

function systemPrefersDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function getStorage() {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function getThemeSnapshot() {
  return readStoredThemePreference(getStorage());
}

function getServerThemeSnapshot(): ThemePreference {
  return "system";
}

function subscribeToThemePreference(onStoreChange: () => void) {
  window.addEventListener(THEME_CHANGE_EVENT, onStoreChange);
  window.addEventListener("storage", onStoreChange);

  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

function applyPreference(preference: ThemePreference) {
  applyThemePreference({
    preference,
    root: document.documentElement.classList,
    systemPrefersDark: systemPrefersDark(),
  });
}

export function AppearanceToggle() {
  const preference = useSyncExternalStore(
    subscribeToThemePreference,
    getThemeSnapshot,
    getServerThemeSnapshot,
  );

  useEffect(() => {
    applyPreference(preference);

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (preference === "system") {
        applyPreference("system");
      }
    };

    media.addEventListener?.("change", onChange);
    return () => media.removeEventListener?.("change", onChange);
  }, [preference]);

  function choose(nextPreference: ThemePreference) {
    writeStoredThemePreference(nextPreference, getStorage());
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  }

  return (
    <div className="mesh-appearance-toggle" aria-label="Appearance">
      <span className="mesh-appearance-toggle__label">Appearance</span>
      <div
        className="mesh-appearance-toggle__options"
        role="group"
        aria-label="Appearance mode"
      >
        {preferences.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-label={option.ariaLabel}
            aria-pressed={preference === option.value}
            className="mesh-appearance-toggle__button"
            data-active={preference === option.value ? "true" : "false"}
            onClick={() => choose(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
