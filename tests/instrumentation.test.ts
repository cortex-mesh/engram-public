import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { register } from "@/instrumentation";
import { GET as getEnrollmentKeys } from "@/app/api/internal/enrollment/v1/keys/route";

describe("instrumentation startup guard", () => {
  beforeEach(() => {
    vi.stubEnv("ENGRAM_URL", "https://login.ctxhost.com");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("keeps the shared production IdP available while Cite enrollment configuration is absent or expired", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENGRAM_AXON_ENROLLMENT_API_KEY", "consumer-test-key");
    vi.stubEnv("ENGRAM_ENROLLMENT_SIGNING_KEY_ID", "");
    vi.stubEnv("ENGRAM_ENROLLMENT_SIGNING_PRIVATE_KEY", "");
    vi.stubEnv("ENGRAM_ENROLLMENT_SIGNING_PUBLIC_KEY", "");
    vi.stubEnv("ENGRAM_ENROLLMENT_SIGNING_NOT_BEFORE", "");
    vi.stubEnv("ENGRAM_ENROLLMENT_SIGNING_NOT_AFTER", "");
    vi.stubEnv("ENGRAM_ENROLLMENT_OVERLAP_SIGNING_KEY_ID", "");
    vi.stubEnv("ENGRAM_ENROLLMENT_OVERLAP_SIGNING_PUBLIC_KEY", "");
    vi.stubEnv("ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_BEFORE", "");
    vi.stubEnv("ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_AFTER", "");

    await expect(register()).resolves.toBeUndefined();
    const response = await getEnrollmentKeys(
      new NextRequest(
        "https://login.ctxhost.com/api/internal/enrollment/v1/keys",
        {
          headers: { Authorization: "Bearer consumer-test-key" },
        },
      ),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ENROLLMENT_STATE_UNAVAILABLE" },
    });
  });

  it("does not make an expired Cite signing window a production startup dependency", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENGRAM_ENROLLMENT_SIGNING_KEY_ID", "expired-key");
    vi.stubEnv("ENGRAM_ENROLLMENT_SIGNING_PRIVATE_KEY", "not-read-at-startup");
    vi.stubEnv("ENGRAM_ENROLLMENT_SIGNING_PUBLIC_KEY", "not-read-at-startup");
    vi.stubEnv(
      "ENGRAM_ENROLLMENT_SIGNING_NOT_BEFORE",
      "2020-01-01T00:00:00.000Z",
    );
    vi.stubEnv(
      "ENGRAM_ENROLLMENT_SIGNING_NOT_AFTER",
      "2020-01-02T00:00:00.000Z",
    );
    await expect(register()).resolves.toBeUndefined();
  });

  it("rejects a missing public URL in production independently of Cite enrollment configuration", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENGRAM_URL", "");
    await expect(register()).rejects.toThrow(
      "ENGRAM_URL must be set in production",
    );
  });

  it("accepts bare HTTPS allowlisted hosts in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENGRAM_URL", "https://login.ctxhost.com");
    vi.stubEnv(
      "ENGRAM_ALLOWED_HOSTS",
      "login.ctxhost.com,auth.ccgtradepost.com",
    );

    await expect(register()).resolves.toBeUndefined();
  });

  it("rejects non-bare allowlisted hosts in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENGRAM_URL", "https://login.ctxhost.com");
    vi.stubEnv("ENGRAM_ALLOWED_HOSTS", "https://auth.ccgtradepost.com");

    await expect(register()).rejects.toThrow(
      "ENGRAM_ALLOWED_HOSTS entries must be bare HTTPS host authorities",
    );
  });

  it("accepts bare HTTPS allowlisted host authorities with ports", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENGRAM_URL", "https://engram.rapidagent.dev:8443");
    vi.stubEnv("ENGRAM_ALLOWED_HOSTS", "login.rapidagent.dev:8443");

    await expect(register()).resolves.toBeUndefined();
  });

  it("logs resolved and missing production app URLs at startup", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENGRAM_URL", "https://login.ctxhost.com");
    vi.stubEnv("ENGRAM_ALLOWED_HOSTS", "login.ctxhost.com");
    vi.stubEnv("NEXT_PUBLIC_DASHBOARD_URL", "https://plexus.ctxhost.com");
    vi.stubEnv("NEXT_PUBLIC_SYNAPSE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_THOUGHTS_URL", "https://thoughts.ctxhost.com");
    vi.stubEnv("NEXT_PUBLIC_AXON_URL", "https://axon.ctxhost.com");
    vi.stubEnv("NEXT_PUBLIC_PULSE_URL", "https://pulse.ctxhost.com");
    vi.stubEnv("NEXT_PUBLIC_GYRUS_URL", "https://gyrus.ctxhost.com");

    await register();

    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("dashboard:https://plexus.ctxhost.com"),
    );
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("synapse:missing"),
    );
  });
});
