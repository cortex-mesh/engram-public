import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

import {
  doesPkceVerifierMatch,
  isNativeClientAllowedForApp,
  isValidNativeClientId,
  nativeAppsForClient,
  nativeTenantHostForLoginOrigin,
  normalizeNativeRedirectUri,
  validateNativeAppKey,
  validateNativeTenantSlug,
  validatePkceCodeChallenge,
  validatePkceCodeVerifier,
} from "@/lib/native-auth";

describe("native auth helpers", () => {
  it("validates first-party native client ids", () => {
    expect(isValidNativeClientId("broca-macos")).toBe(true);
    expect(isValidNativeClientId("synapse.ios-dev")).toBe(true);
    expect(isValidNativeClientId("Broca")).toBe(false);
    expect(isValidNativeClientId("../broca")).toBe(false);
  });

  it("validates native tenant and app authorization context", () => {
    expect(validateNativeTenantSlug("cortex")).toBe("cortex");
    expect(validateNativeTenantSlug("demo-lab")).toBe("demo-lab");
    expect(validateNativeTenantSlug("Demo")).toBeNull();
    expect(validateNativeTenantSlug("../demo")).toBeNull();

    expect(validateNativeAppKey("synapse")).toBe("synapse");
    expect(validateNativeAppKey("unknown")).toBeNull();
    expect(isNativeClientAllowedForApp("synapse-native", "synapse")).toBe(true);
    expect(isNativeClientAllowedForApp("synapse-native", "thoughts")).toBe(false);
    expect(isNativeClientAllowedForApp("unregistered-native", "synapse")).toBe(false);
    expect(nativeAppsForClient("synapse-native")).toEqual(["synapse"]);
    expect(nativeAppsForClient("unregistered-native")).toEqual([]);
  });

  it("derives tenant hosts from native login origins", () => {
    expect(
      nativeTenantHostForLoginOrigin({
        slug: "cortex",
        loginOrigin: "https://login.dev.ctxhost.com",
      }),
    ).toBe("cortex.dev.ctxhost.com");
    expect(
      nativeTenantHostForLoginOrigin({
        slug: "customer",
        loginOrigin: "https://login.ctxhost.com",
      }),
    ).toBe("customer.ctxhost.com");
    expect(
      nativeTenantHostForLoginOrigin({
        slug: "lab",
        loginOrigin: "https://login.rapidagent.dev:8443",
      }),
    ).toBe("lab.rapidagent.dev:8443");
  });

  it("normalizes redirect URIs while rejecting fragments", () => {
    expect(normalizeNativeRedirectUri("broca://auth/callback")).toBe(
      "broca://auth/callback",
    );
    expect(normalizeNativeRedirectUri("https://login.dev.ctxhost.com/broca/callback")).toBe(
      "https://login.dev.ctxhost.com/broca/callback",
    );
    expect(normalizeNativeRedirectUri("broca://auth/callback#token")).toBeNull();
    expect(normalizeNativeRedirectUri("/relative")).toBeNull();
  });

  it("validates S256 PKCE verifier and challenge values", () => {
    const verifier = "A".repeat(43);
    const challenge = "abc_DEF-123".padEnd(43, "x");

    expect(validatePkceCodeVerifier(verifier)).toBe(verifier);
    expect(validatePkceCodeChallenge(challenge)).toBe(challenge);
    expect(validatePkceCodeVerifier("short")).toBeNull();
    expect(validatePkceCodeChallenge("contains+plus".padEnd(43, "x"))).toBeNull();
  });

  it("matches PKCE verifier to the stored challenge", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

    expect(doesPkceVerifierMatch(verifier, challenge)).toBe(true);
    expect(doesPkceVerifierMatch(`${verifier}x`, challenge)).toBe(false);
  });
});
