import { afterEach, describe, expect, it, vi } from "vitest";

const { mockNativeAuthClientFindUnique } = vi.hoisted(() => ({
  mockNativeAuthClientFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    nativeAuthClient: {
      findUnique: mockNativeAuthClientFindUnique,
    },
  },
}));

import {
  CITE_THE_MOVE_AUTH_HOST,
  CITE_THE_MOVE_CALLBACK,
  CITE_THE_MOVE_CLIENT_ID,
  getSafeHostBoundContinuationTarget,
  isAllowedHostBoundContinuationTarget,
  resolveAuthClientForHost,
  resolveAuthClientForRequest,
} from "@/lib/auth-host-client";
import {
  CONTINUATION_REJECTION_MARKER,
  extractClientIdsFromContinuation,
  extractRequestedClientIds,
} from "@/lib/auth-client-config";
import { encodeRedirectTarget } from "@/lib/redirect-target";

describe("Cite the Move host-bound auth client", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mockNativeAuthClientFindUnique.mockReset();
  });

  it("accepts only an enabled Cite-owned registered callback", async () => {
    mockNativeAuthClientFindUnique.mockResolvedValue({
      enabled: true,
      redirectUris: [{ id: "redirect-1" }],
    });

    await expect(isAllowedHostBoundContinuationTarget(
      CITE_THE_MOVE_CALLBACK,
      CITE_THE_MOVE_CLIENT_ID,
      CITE_THE_MOVE_AUTH_HOST,
    )).resolves.toBe(true);
    expect(mockNativeAuthClientFindUnique).toHaveBeenCalledWith({
      where: { clientId: CITE_THE_MOVE_CLIENT_ID },
      select: {
        enabled: true,
        redirectUris: {
          where: { redirectUri: CITE_THE_MOVE_CALLBACK, enabled: true },
          select: { id: true },
          take: 1,
        },
      },
    });
  });

  it.each([
    "https://axon.dev.ctxhost.com/auth/callback",
    "https://axon.on-prem.ctxhost.com/auth/callback",
  ])("rejects an enabled axon-web callback outside Cite's canonical external continuation: %s", async (target) => {
    await expect(isAllowedHostBoundContinuationTarget(
      target,
      CITE_THE_MOVE_CLIENT_ID,
      CITE_THE_MOVE_AUTH_HOST,
    )).resolves.toBe(false);
    expect(mockNativeAuthClientFindUnique).not.toHaveBeenCalled();
  });

  it("keeps same-host relative account continuations valid without a redirect-row lookup", async () => {
    await expect(isAllowedHostBoundContinuationTarget(
      "/account?client_id=axon-web",
      CITE_THE_MOVE_CLIENT_ID,
      CITE_THE_MOVE_AUTH_HOST,
    )).resolves.toBe(true);
    expect(mockNativeAuthClientFindUnique).not.toHaveBeenCalled();
  });

  it.each([
    ["missing client", null],
    ["disabled client", { enabled: false, redirectUris: [{ id: "redirect-1" }] }],
    ["disabled or missing redirect registration", { enabled: true, redirectUris: [] }],
  ])("rejects a %s instead of honoring the Cite callback", async (_label, client) => {
    mockNativeAuthClientFindUnique.mockResolvedValue(client);

    await expect(isAllowedHostBoundContinuationTarget(
      CITE_THE_MOVE_CALLBACK,
      CITE_THE_MOVE_CLIENT_ID,
      CITE_THE_MOVE_AUTH_HOST,
    )).resolves.toBe(false);
    await expect(getSafeHostBoundContinuationTarget(
      CITE_THE_MOVE_CALLBACK,
      "/account?client_id=axon-web",
      CITE_THE_MOVE_CLIENT_ID,
      CITE_THE_MOVE_AUTH_HOST,
    )).resolves.toBe("/account?client_id=axon-web");
  });

  it("fails closed when the Cite registration lookup cannot complete", async () => {
    mockNativeAuthClientFindUnique.mockRejectedValue(new Error("database unavailable"));

    await expect(isAllowedHostBoundContinuationTarget(
      CITE_THE_MOVE_CALLBACK,
      CITE_THE_MOVE_CLIENT_ID,
      CITE_THE_MOVE_AUTH_HOST,
    )).resolves.toBe(false);
  });

  it("rejects a globally allowed Tradepost target on Cite while preserving the canonical host", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING", "https://ccgtradepost.com");
    const tradepost = "https://ccgtradepost.com/account";

    await expect(isAllowedHostBoundContinuationTarget(
      tradepost,
      CITE_THE_MOVE_CLIENT_ID,
      CITE_THE_MOVE_AUTH_HOST,
    )).resolves.toBe(false);
    await expect(isAllowedHostBoundContinuationTarget(
      tradepost,
      null,
      "login.ctxhost.com",
    )).resolves.toBe(true);
  });

  it("uses Cite's own account fallback instead of a caller's external fallback", async () => {
    await expect(getSafeHostBoundContinuationTarget(
      null,
      "https://cortex.dev.ctxhost.com/",
      CITE_THE_MOVE_CLIENT_ID,
      CITE_THE_MOVE_AUTH_HOST,
    )).resolves.toBe("/account?client_id=axon-web");
  });

  it("binds a bare allowlisted Cite host to axon-web", () => {
    vi.stubEnv("ENGRAM_ALLOWED_HOSTS", CITE_THE_MOVE_AUTH_HOST);
    expect(resolveAuthClientForRequest(null, new Headers({ host: CITE_THE_MOVE_AUTH_HOST }))).toEqual({
      clientId: CITE_THE_MOVE_CLIENT_ID,
      rejected: false,
    });
  });

  it("rejects a conflicting client id on the Cite host", () => {
    expect(resolveAuthClientForHost("tradepost-web", CITE_THE_MOVE_AUTH_HOST)).toEqual({
      clientId: null,
      rejected: true,
    });
  });

  it("rejects direct and nested client-id disagreement instead of letting direct axon-web mask tradepost-web", () => {
    const params = new URLSearchParams({
      client_id: "axon-web",
      redirect_uri: "/authorize?client_id=tradepost-web",
    });
    expect(resolveAuthClientForHost(
      extractRequestedClientIds(params),
      CITE_THE_MOVE_AUTH_HOST,
    )).toEqual({ clientId: null, rejected: true });
  });

  it("collects duplicate, malformed, and recursively nested client ids before host resolution", () => {
    const recursive = "/continue?client_id=broca-macos-dev";
    const params = new URLSearchParams({
      client_id: "axon-web",
      redirect_uri: `/authorize?client_id=tradepost-web&client_id=tradepost-web!&rt=${encodeURIComponent(encodeRedirectTarget(recursive))}`,
    });

    expect(extractRequestedClientIds(params)).toEqual([
      "axon-web",
      "tradepost-web",
      "tradepost-web!",
      "broca-macos-dev",
    ]);
    expect(extractClientIdsFromContinuation(params.get("redirect_uri"))).toContain("tradepost-web!");
    expect(resolveAuthClientForHost(
      extractRequestedClientIds(params),
      CITE_THE_MOVE_AUTH_HOST,
    )).toEqual({ clientId: null, rejected: true });
  });

  it("keeps Cite binding when a public Cite Host is paired with a conflicting forwarded host", () => {
    vi.stubEnv("ENGRAM_ALLOWED_HOSTS", "login.ctxhost.com,auth.citethemove.com");
    expect(resolveAuthClientForRequest(null, new Headers({
      host: CITE_THE_MOVE_AUTH_HOST,
      "x-forwarded-host": "login.ctxhost.com",
    }))).toEqual({ clientId: CITE_THE_MOVE_CLIENT_ID, rejected: false });
  });

  it("fails closed when a continuation exceeds the recursion or parse-size bounds", () => {
    let nested = "/continue?client_id=tradepost-web";
    for (let depth = 0; depth < 6; depth += 1) {
      nested = `/continue?redirect_uri=${encodeURIComponent(nested)}`;
    }
    const depthIds = extractRequestedClientIds(new URLSearchParams({ redirect_uri: nested }));
    const oversizedIds = extractClientIdsFromContinuation(`/continue?payload=${"x".repeat(4097)}`);

    expect(depthIds).toContain(CONTINUATION_REJECTION_MARKER);
    expect(oversizedIds).toContain(CONTINUATION_REJECTION_MARKER);
    expect(resolveAuthClientForHost(depthIds, CITE_THE_MOVE_AUTH_HOST)).toEqual({
      clientId: null,
      rejected: true,
    });
  });

  it("fails closed on malformed continuation URLs and nondecodable durable targets", () => {
    const malformedUrl = extractClientIdsFromContinuation("http://[");
    const malformedNestedRt = extractClientIdsFromContinuation("/continue?rt=not-base64");
    const malformedTopLevelRt = extractRequestedClientIds(new URLSearchParams({ rt: "not-base64" }));

    for (const clientIds of [malformedUrl, malformedNestedRt, malformedTopLevelRt]) {
      expect(clientIds).toContain(CONTINUATION_REJECTION_MARKER);
      expect(resolveAuthClientForHost(clientIds, CITE_THE_MOVE_AUTH_HOST)).toEqual({
        clientId: null,
        rejected: true,
      });
    }
  });

  it("rejects an explicit empty continuation target", () => {
    expect(extractClientIdsFromContinuation("")).toContain(CONTINUATION_REJECTION_MARKER);
  });

  it("rejects an explicit empty top-level durable target", () => {
    expect(extractRequestedClientIds(new URLSearchParams({ rt: "" }))).toContain(
      CONTINUATION_REJECTION_MARKER,
    );
  });

  it("rejects an explicit empty nested durable target", () => {
    expect(extractClientIdsFromContinuation("/continue?rt=")).toContain(
      CONTINUATION_REJECTION_MARKER,
    );
  });

  it("does not bind an unallowlisted spoof or lookalike host", () => {
    vi.stubEnv("ENGRAM_ALLOWED_HOSTS", CITE_THE_MOVE_AUTH_HOST);
    for (const host of ["evil.example.com", "auth.citethemove.com.evil.example.com"]) {
      expect(resolveAuthClientForRequest(null, new Headers({ host }))).toEqual({
        clientId: null,
        rejected: false,
      });
    }
  });
});
