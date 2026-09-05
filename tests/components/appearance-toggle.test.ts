import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AppearanceToggle } from "@/components/auth/appearance-toggle";
import {
  applyThemePreference,
  normalizeThemePreference,
  readStoredThemePreference,
  type ThemePreference,
  writeStoredThemePreference,
} from "@/lib/theme-preference";

describe("theme preference helpers", () => {
  it("normalizes persisted theme values to system, light, or dark", () => {
    expect(normalizeThemePreference("system")).toBe("system");
    expect(normalizeThemePreference("light")).toBe("light");
    expect(normalizeThemePreference("dark")).toBe("dark");
    expect(normalizeThemePreference(null)).toBe("system");
    expect(normalizeThemePreference("unexpected")).toBe("system");
  });

  it("applies light, dark, and system preferences to the document root", () => {
    const root = { classList: new Set<string>() };
    const setPreference = (
      preference: ThemePreference,
      systemPrefersDark = false,
    ) => {
      applyThemePreference({
        preference,
        root: root.classList,
        systemPrefersDark,
      });
      return root.classList.has("dark");
    };

    expect(setPreference("dark", false)).toBe(true);
    expect(setPreference("light", true)).toBe(false);
    expect(setPreference("system", true)).toBe(true);
    expect(setPreference("system", false)).toBe(false);
  });

  it("safely reads and writes preferences when browser storage is restricted", () => {
    const restrictedStorage = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
      removeItem() {
        throw new Error("blocked");
      },
    };

    expect(readStoredThemePreference(restrictedStorage)).toBe("system");
    expect(() =>
      writeStoredThemePreference("dark", restrictedStorage),
    ).not.toThrow();
    expect(() =>
      writeStoredThemePreference("system", restrictedStorage),
    ).not.toThrow();
  });
});

describe("AppearanceToggle", () => {
  it("renders a system, light, and dark segmented control for auth pages", () => {
    const html = renderToStaticMarkup(createElement(AppearanceToggle));

    expect(html).toContain("Appearance");
    expect(html).toContain("System");
    expect(html).toContain("Light");
    expect(html).toContain("Dark");
    expect(html).toContain('aria-label="Use system appearance"');
    expect(html).toContain('aria-label="Use light appearance"');
    expect(html).toContain('aria-label="Use dark appearance"');
  });
});
