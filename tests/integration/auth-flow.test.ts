/**
 * Integration test: waitlist request plus login → refresh → logout against a real
 * PostgreSQL database. Unlike the unit tests in tests/api/, this exercises
 * Prisma queries, unique constraints, and auth token persistence end-to-end.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

process.env.ENGRAM_JWT_SECRET = "integration-test-secret-at-least-32-bytes-long-for-HS256";

import { prisma, prismaUnscoped } from "@/lib/prisma";
import { sha256 } from "@/lib/crypto";
import { hashPassword } from "@/lib/password";
import { POST as waitlistPOST } from "@/app/api/waitlist/route";
import { POST as loginPOST } from "@/app/api/auth/login/route";
import { POST as refreshPOST } from "@/app/api/auth/refresh/route";
import { POST as logoutPOST } from "@/app/api/auth/logout/route";
import { POST as tokenPOST } from "@/app/api/auth/token/route";

function createJsonRequest(url: string, body: object, cookies?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cookies) headers.Cookie = cookies;
  const request = new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return new NextRequest(request);
}

function extractCookieValue(
  setCookieHeaders: string[],
  name: string,
): string | undefined {
  const cookie = setCookieHeaders.find((c) => c.startsWith(`${name}=`));
  if (!cookie) return undefined;
  const match = cookie.match(new RegExp(`^${name}=([^;]+)`));
  return match?.[1];
}

async function createUser(email: string, password: string, displayName: string) {
  return prisma.user.create({
    data: {
      email,
      username: email.split("@")[0],
      displayName,
      passwordHash: await hashPassword(password),
      emailVerified: true,
    },
  });
}

async function createUnverifiedUser(email: string, password: string, displayName: string) {
  return prisma.user.create({
    data: {
      email,
      username: email.split("@")[0],
      displayName,
      passwordHash: await hashPassword(password),
      emailVerified: false,
    },
  });
}

describe("Integration: waitlist and auth flows", () => {
  beforeEach(async () => {
    await prismaUnscoped.nativeAuthAuthorizationCode.deleteMany({});
    await prismaUnscoped.nativeAuthRedirectUri.deleteMany({});
    await prismaUnscoped.nativeAuthClient.deleteMany({});
    await prismaUnscoped.refreshToken.deleteMany({});
    await prismaUnscoped.oAuthAccount.deleteMany({});
    await prismaUnscoped.magicLink.deleteMany({});
    await prismaUnscoped.orgMember.deleteMany({});
    await prismaUnscoped.organization.deleteMany({});
    await prismaUnscoped.waitlistRequest.deleteMany({});
    await prismaUnscoped.user.deleteMany({});
  });

  it("stores a waitlist request in the database", async () => {
    const res = await waitlistPOST(
      createJsonRequest("http://localhost:3104/api/waitlist", {
        email: "alice@example.com",
        displayName: "Alice",
      }),
    );

    expect(res.status).toBe(202);

    const request = await prisma.waitlistRequest.findUnique({
      where: { email: "alice@example.com" },
    });
    expect(request).not.toBeNull();
    expect(request?.displayName).toBe("Alice");
  });

  it("does not create duplicate waitlist requests", async () => {
    await waitlistPOST(
      createJsonRequest("http://localhost:3104/api/waitlist", {
        email: "bob@example.com",
        displayName: "Bob",
      }),
    );

    const res = await waitlistPOST(
      createJsonRequest("http://localhost:3104/api/waitlist", {
        email: "bob@example.com",
        displayName: "Bob Again",
      }),
    );

    expect(res.status).toBe(202);

    const count = await prisma.waitlistRequest.count({
      where: { email: "bob@example.com" },
    });
    expect(count).toBe(1);
  });

  it("login succeeds for an admin-provisioned user and persists refresh token", async () => {
    await createUser("carol@example.com", "mypassword123", "Carol");

    const loginRes = await loginPOST(
      createJsonRequest("http://localhost:3104/api/auth/login", {
        email: "carol@example.com",
        password: "mypassword123",
      }),
    );
    expect(loginRes.status).toBe(200);

    const tokenCount = await prisma.refreshToken.count();
    expect(tokenCount).toBeGreaterThanOrEqual(1);
  });

  it("login rejects wrong password", async () => {
    await createUser("dave@example.com", "correctpassword", "Dave");

    const res = await loginPOST(
      createJsonRequest("http://localhost:3104/api/auth/login", {
        email: "dave@example.com",
        password: "wrongpassword",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("login rejects an unverified password user without minting a refresh token", async () => {
    await createUnverifiedUser("unverified@example.com", "mypassword123", "Unverified");

    const res = await loginPOST(
      createJsonRequest("http://localhost:3104/api/auth/login", {
        email: "unverified@example.com",
        password: "mypassword123",
      }),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("Verify your email");
    await expect(prisma.refreshToken.count()).resolves.toBe(0);
  });

  it("refresh rotates the token (old token consumed within grace, new token active)", async () => {
    await createUser("eve@example.com", "mypassword123", "Eve");

    const loginRes = await loginPOST(
      createJsonRequest("http://localhost:3104/api/auth/login", {
        email: "eve@example.com",
        password: "mypassword123",
      }),
    );
    const setCookies = loginRes.headers.getSetCookie();
    const refreshToken = extractCookieValue(setCookies, "engram-refresh");
    expect(refreshToken).toBeTruthy();

    const tokensBeforeRefresh = await prisma.refreshToken.findMany();
    expect(tokensBeforeRefresh).toHaveLength(1);
    const loginTokenHash = (await import("@/lib/crypto")).sha256(refreshToken!);

    const refreshRes = await refreshPOST(
      createJsonRequest(
        "http://localhost:3104/api/auth/refresh",
        {},
        `engram-refresh=${refreshToken}`,
      ),
    );
    expect(refreshRes.status).toBe(200);

    // ADR-031: the rotated token's row is RETAINED (consumedAt + encrypted
    // successor) within the grace window rather than deleted; a new active row
    // (consumedAt null) is the successor.
    const tokensAfterRefresh = await prisma.refreshToken.findMany();
    const active = tokensAfterRefresh.filter((t) => t.consumedAt === null);
    const consumed = tokensAfterRefresh.filter((t) => t.consumedAt !== null);
    expect(active).toHaveLength(1);
    expect(active[0].tokenHash).not.toBe(loginTokenHash);
    expect(consumed).toHaveLength(1);
    expect(consumed[0].tokenHash).toBe(loginTokenHash);
    expect(consumed[0].replacement).toBeTruthy(); // encrypted successor stored
  });

  it("concurrent refreshes with the same token converge on ONE successor (idempotent — no parallel session)", async () => {
    // The deploy / cross-container race: two requests carrying the same refresh
    // token race to rotate. One wins; the other is graced with the SAME
    // successor — a single chain, so a token thief racing the window can't fork
    // an independent session.
    await createUser("carol@example.com", "mypassword123", "Carol");
    const loginRes = await loginPOST(
      createJsonRequest("http://localhost:3104/api/auth/login", {
        email: "carol@example.com",
        password: "mypassword123",
      }),
    );
    const refreshToken = extractCookieValue(loginRes.headers.getSetCookie(), "engram-refresh");

    const [r1, r2] = await Promise.all([
      refreshPOST(createJsonRequest("http://localhost:3104/api/auth/refresh", {}, `engram-refresh=${refreshToken}`)),
      refreshPOST(createJsonRequest("http://localhost:3104/api/auth/refresh", {}, `engram-refresh=${refreshToken}`)),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const t1 = extractCookieValue(r1.headers.getSetCookie(), "engram-refresh");
    const t2 = extractCookieValue(r2.headers.getSetCookie(), "engram-refresh");
    expect(t1).toBeTruthy();
    expect(t1).toBe(t2); // idempotent — one successor for both callers

    const user = await prisma.user.findUnique({ where: { email: "carol@example.com" } });
    const active = await prisma.refreshToken.count({ where: { userId: user!.id, consumedAt: null } });
    expect(active).toBe(1); // exactly one active successor, no forks
  });

  it("reuse within the grace window returns the same successor (graced, not theft)", async () => {
    await createUser("frank@example.com", "mypassword123", "Frank");
    const loginRes = await loginPOST(
      createJsonRequest("http://localhost:3104/api/auth/login", {
        email: "frank@example.com",
        password: "mypassword123",
      }),
    );
    const refreshToken = extractCookieValue(loginRes.headers.getSetCookie(), "engram-refresh");

    const refresh1 = await refreshPOST(
      createJsonRequest("http://localhost:3104/api/auth/refresh", {}, `engram-refresh=${refreshToken}`),
    );
    expect(refresh1.status).toBe(200);
    const successor1 = extractCookieValue(refresh1.headers.getSetCookie(), "engram-refresh");

    // Reuse the just-rotated token immediately — within the grace window.
    const refresh2 = await refreshPOST(
      createJsonRequest("http://localhost:3104/api/auth/refresh", {}, `engram-refresh=${refreshToken}`),
    );
    expect(refresh2.status).toBe(200); // graced, not 401
    const successor2 = extractCookieValue(refresh2.headers.getSetCookie(), "engram-refresh");
    expect(successor2).toBe(successor1); // same successor — one chain, no fork

    const user = await prisma.user.findUnique({ where: { email: "frank@example.com" } });
    const active = await prisma.refreshToken.count({ where: { userId: user!.id, consumedAt: null } });
    expect(active).toBe(1); // session survives, no orphan successor
  });

  it("reuse of a token whose row is gone (e.g. after logout/revoke) revokes the family", async () => {
    await createUser("dave@example.com", "mypassword123", "Dave");
    const loginRes = await loginPOST(
      createJsonRequest("http://localhost:3104/api/auth/login", {
        email: "dave@example.com",
        password: "mypassword123",
      }),
    );
    const refreshToken = extractCookieValue(loginRes.headers.getSetCookie(), "engram-refresh");
    const hash = (await import("@/lib/crypto")).sha256(refreshToken!);
    const user = await prisma.user.findUnique({ where: { email: "dave@example.com" } });

    // The row is gone entirely (logout / password change / admin revoke) — a
    // replay must NOT be graceable; it revokes.
    await prisma.refreshToken.deleteMany({ where: { tokenHash: hash } });

    const replay = await refreshPOST(
      createJsonRequest("http://localhost:3104/api/auth/refresh", {}, `engram-refresh=${refreshToken}`),
    );
    expect(replay.status).toBe(401);
    const remaining = await prisma.refreshToken.count({ where: { userId: user!.id } });
    expect(remaining).toBe(0);
  });

  it("theft detection: reuse OUTSIDE the grace window revokes all user tokens", async () => {
    await createUser("frank2@example.com", "mypassword123", "Frank2");
    const loginRes = await loginPOST(
      createJsonRequest("http://localhost:3104/api/auth/login", {
        email: "frank2@example.com",
        password: "mypassword123",
      }),
    );
    const refreshToken = extractCookieValue(loginRes.headers.getSetCookie(), "engram-refresh");
    const oldHash = (await import("@/lib/crypto")).sha256(refreshToken!);

    const refresh1 = await refreshPOST(
      createJsonRequest("http://localhost:3104/api/auth/refresh", {}, `engram-refresh=${refreshToken}`),
    );
    expect(refresh1.status).toBe(200);

    // Age the consumed token past the grace window, then reuse it → theft.
    await prisma.refreshToken.updateMany({
      where: { tokenHash: oldHash },
      data: { consumedAt: new Date(Date.now() - 60_000) },
    });

    const refresh2 = await refreshPOST(
      createJsonRequest("http://localhost:3104/api/auth/refresh", {}, `engram-refresh=${refreshToken}`),
    );
    expect(refresh2.status).toBe(401);

    const user = await prisma.user.findUnique({ where: { email: "frank2@example.com" } });
    const remaining = await prisma.refreshToken.count({ where: { userId: user!.id } });
    expect(remaining).toBe(0); // whole family revoked
  });

  it("logout clears within-grace predecessors so a replayed old token can't be graced", async () => {
    await createUser("heidi@example.com", "mypassword123", "Heidi");
    const loginRes = await loginPOST(
      createJsonRequest("http://localhost:3104/api/auth/login", {
        email: "heidi@example.com",
        password: "mypassword123",
      }),
    );
    const tokenA = extractCookieValue(loginRes.headers.getSetCookie(), "engram-refresh");

    // Rotate A -> B, then log out with the active token B.
    const refresh1 = await refreshPOST(
      createJsonRequest("http://localhost:3104/api/auth/refresh", {}, `engram-refresh=${tokenA}`),
    );
    expect(refresh1.status).toBe(200);
    const tokenB = extractCookieValue(refresh1.headers.getSetCookie(), "engram-refresh");
    await logoutPOST(
      createJsonRequest("http://localhost:3104/api/auth/logout", {}, `engram-refresh=${tokenB}`),
    );

    // Replay the pre-rotation token A within the grace window — must NOT be
    // graced back into a session after logout; the family is fully gone.
    const replayA = await refreshPOST(
      createJsonRequest("http://localhost:3104/api/auth/refresh", {}, `engram-refresh=${tokenA}`),
    );
    expect(replayA.status).toBe(401);
    const user = await prisma.user.findUnique({ where: { email: "heidi@example.com" } });
    const remaining = await prisma.refreshToken.count({ where: { userId: user!.id } });
    expect(remaining).toBe(0);
  });

  it("logout revokes the refresh token", async () => {
    await createUser("grace@example.com", "mypassword123", "Grace");
    const loginRes = await loginPOST(
      createJsonRequest("http://localhost:3104/api/auth/login", {
        email: "grace@example.com",
        password: "mypassword123",
      }),
    );
    const refreshToken = extractCookieValue(
      loginRes.headers.getSetCookie(),
      "engram-refresh",
    );

    const tokensBefore = await prisma.refreshToken.count();
    expect(tokensBefore).toBe(1);

    const logoutRes = await logoutPOST(
      createJsonRequest(
        "http://localhost:3104/api/auth/logout",
        {},
        `engram-refresh=${refreshToken}`,
      ),
    );
    expect(logoutRes.status).toBe(200);

    const tokensAfter = await prisma.refreshToken.count();
    expect(tokensAfter).toBe(0);
  });

  it("native token exchange consumes a PKCE authorization code and stores refresh token", async () => {
    const user = await createUser("broca@example.com", "mypassword123", "Broca User");
    const clientId = "broca-macos-dev";
    const redirectUri = "broca://auth/callback";
    const code = "native-auth-code";
    const codeVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const codeChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

    await prisma.nativeAuthClient.create({
      data: {
        clientId,
        displayName: "Broca Dev",
        redirectUris: {
          create: [{ redirectUri }],
        },
      },
    });
    await prisma.nativeAuthAuthorizationCode.create({
      data: {
        clientId,
        userId: user.id,
        redirectUri,
        codeHash: sha256(code),
        codeChallenge,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const tokenRes = await tokenPOST(
      createJsonRequest("http://localhost:3104/api/auth/token", {
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    );

    expect(tokenRes.status).toBe(200);
    const body = await tokenRes.json();
    expect(body.accessToken).toBeDefined();
    expect(body.refreshToken).toBeDefined();

    const consumedCode = await prisma.nativeAuthAuthorizationCode.findUnique({
      where: { codeHash: sha256(code) },
    });
    expect(consumedCode?.consumedAt).toBeInstanceOf(Date);

    const refreshTokens = await prisma.refreshToken.count({
      where: { userId: user.id },
    });
    expect(refreshTokens).toBe(1);
  });
});
