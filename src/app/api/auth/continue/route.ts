import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  ACCESS_COOKIE_NAME,
  ACCESS_COOKIE_OPTIONS,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_OPTIONS,
  verifyToken,
} from "@/lib/jwt";
import { sha256 } from "@/lib/crypto";
import { getRequestCookieValues } from "@/lib/cookie-tokens";
import { rotateRefreshToken, revokeTokenFamily } from "@/lib/refresh-rotation";
import { getDefaultLandingUrl, getDefaultPostLoginTarget } from "@/lib/apps";
import { withAccountClientContext } from "@/lib/auth-redirect";
import {
  consumeRateLimit,
  getClientIp,
  rateLimitResponse,
} from "@/lib/rate-limit";
import { getAllowedRequestHost, getPublicOrigin } from "@/lib/public-origin";
import { extractClientIdFromRedirectUri, extractRequestedClientIds } from "@/lib/auth-client-config";
import {
  getHostBoundContinuationFallback,
  getSafeHostBoundContinuationTarget,
  resolveAuthClientForRequest,
} from "@/lib/auth-host-client";
import {
  REDIRECT_TARGET_PARAM,
  encodeRedirectTarget,
  readRedirectTarget,
} from "@/lib/redirect-target";

function loginRedirect(request: NextRequest, target: string) {
  const loginUrl = new URL("/login", getPublicOrigin(request));
  loginUrl.searchParams.set("redirect_uri", target);
  loginUrl.searchParams.set(REDIRECT_TARGET_PARAM, encodeRedirectTarget(target));
  const clientId = extractClientIdFromRedirectUri(target);
  if (clientId) loginUrl.searchParams.set("client_id", clientId);
  return loginUrl.toString();
}

function toAbsoluteRedirectTarget(target: string, request: NextRequest): string {
  if (target.startsWith("http://") || target.startsWith("https://")) {
    return target;
  }

  return `${getPublicOrigin(request)}${target}`;
}

export async function GET(request: NextRequest) {
  const requestedTarget = readRedirectTarget(request.nextUrl.searchParams);
  const allowedHost = getAllowedRequestHost(request.headers);
  const clientResolution = resolveAuthClientForRequest(
    extractRequestedClientIds(request.nextUrl.searchParams),
    request.headers,
  );
  if (clientResolution.rejected) {
    return NextResponse.redirect(new URL("/login?error=invalid_client", getPublicOrigin(request)));
  }
  const requestedClientId = clientResolution.clientId;
  // Resolve the host-bound client before selecting a fallback. In production
  // the global landing URL is Tradepost, which must never become Cite's bare
  // auth continuation destination.
  const defaultTarget =
    getHostBoundContinuationFallback(requestedClientId, allowedHost) ||
    getDefaultLandingUrl();
  const fallbackTarget = await getSafeHostBoundContinuationTarget(
    requestedTarget,
    defaultTarget,
    requestedClientId,
    allowedHost,
  );
  const forceLogin = request.nextUrl.searchParams.get("prompt") === "login";

  if (forceLogin) {
    console.info("[engram][continue] prompt=login requested; redirecting to login");
    return NextResponse.redirect(loginRedirect(request, fallbackTarget));
  }

  const accessTokens = getRequestCookieValues(request, ACCESS_COOKIE_NAME);
  for (const accessToken of accessTokens) {
    try {
      const payload = await verifyToken(accessToken);
      if (payload.type === "access") {
        const user = await prisma.user.findUnique({
          where: { id: payload.userId },
          select: {
            lastOrgId: true,
            orgMembers: {
              orderBy: { createdAt: "asc" },
              include: {
                org: {
                  select: { id: true, slug: true },
                },
              },
            },
          },
        });
        const target = withAccountClientContext(
          await getSafeHostBoundContinuationTarget(
            requestedTarget,
            getDefaultPostLoginTarget({
              role: payload.role,
              orgMemberships: user?.orgMembers,
              lastOrgId: user?.lastOrgId,
            }),
            requestedClientId,
            allowedHost,
          ),
          requestedClientId,
        );
        console.info("[engram][continue] valid access token present; redirecting", { userId: payload.userId });
        return NextResponse.redirect(toAbsoluteRedirectTarget(target, request));
      }
      console.warn("[engram][continue] non-access token found in access cookie", { type: payload.type });
    } catch {
      // Keep looking: browsers can send host-only and domain cookies with the
      // same name, and NextRequest.cookies.get() exposes only one of them.
    }
  }
  if (accessTokens.length > 0) {
    console.warn("[engram][continue] access cookies invalid or expired; attempting refresh");
  } else {
    console.warn("[engram][continue] no access token present; attempting refresh");
  }

  const refreshTokens = getRequestCookieValues(request, REFRESH_COOKIE_NAME);
  if (refreshTokens.length === 0) {
    console.warn("[engram][continue] no refresh token present; redirecting to login");
    return NextResponse.redirect(loginRedirect(request, fallbackTarget));
  }

  // Same bucket as POST /api/auth/refresh — this branch performs the same
  // DB-backed rotation, so a stolen refresh cookie can't dodge the limit
  // by hammering the redirect path instead.
  const rotateLimit = await consumeRateLimit(
    `refresh:ip:${getClientIp(request)}`,
    60,
    60 * 1000,
  );
  if (!rotateLimit.allowed) {
    console.warn("[engram][continue] refresh rotation rate-limited");
    return rateLimitResponse(rotateLimit.retryAfterSeconds);
  }

  const verifiedRefreshTokens: Array<{
    token: string;
    payload: Awaited<ReturnType<typeof verifyToken>>;
  }> = [];
  for (const refreshToken of refreshTokens) {
    let payload;
    try {
      payload = await verifyToken(refreshToken);
    } catch {
      continue;
    }

    if (payload.type !== "refresh") {
      console.warn("[engram][continue] invalid refresh token type", { type: payload.type });
      continue;
    }

    verifiedRefreshTokens.push({ token: refreshToken, payload });
  }

  let selectedRefresh = verifiedRefreshTokens[0] ?? null;
  if (verifiedRefreshTokens.length > 1) {
    for (const candidate of verifiedRefreshTokens) {
      const tokenRow = await prisma.refreshToken.findUnique({
        where: { tokenHash: sha256(candidate.token) },
        select: { consumedAt: true, expiresAt: true },
      });
      if (tokenRow && !tokenRow.consumedAt && tokenRow.expiresAt > new Date()) {
        selectedRefresh = candidate;
        break;
      }
    }
  }

  if (!selectedRefresh) {
    console.warn("[engram][continue] no valid refresh token candidate; redirecting to login");
    return NextResponse.redirect(loginRedirect(request, fallbackTarget));
  }

  const { token: refreshToken, payload } = selectedRefresh;
  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: {
      id: true,
      displayName: true,
      role: true,
      lastOrgId: true,
      orgMembers: {
        orderBy: { createdAt: "asc" },
        include: {
          org: {
            select: { id: true, slug: true },
          },
        },
      },
    },
  });
  if (!user) {
    console.warn("[engram][continue] user not found for refresh token; redirecting to login", { userId: payload.userId });
    return NextResponse.redirect(loginRedirect(request, fallbackTarget));
  }

  // Atomic single-winner rotation with the ADR-031 reuse-grace window — same
  // helper (and same reuse-revoke + audit) as /api/auth/refresh, so both refresh
  // paths stay identical. This is the path the browser SSO redirect actually uses.
  const rotation = await rotateRefreshToken(
    refreshToken,
    { id: user.id, displayName: user.displayName, role: user.role },
    request,
  );

  if (rotation.kind === "reuse") {
    console.warn("[engram][continue] refresh token reuse outside grace window; revoking session family", { userId: payload.userId });
    await revokeTokenFamily(payload.userId, request);
    return NextResponse.redirect(loginRedirect(request, fallbackTarget));
  }

  const { accessToken: newAccessToken, refreshToken: newRefreshToken } = rotation;

  const target = withAccountClientContext(
    await getSafeHostBoundContinuationTarget(
      requestedTarget,
      getDefaultPostLoginTarget({
        role: user.role,
        orgMemberships: user.orgMembers,
        lastOrgId: user.lastOrgId,
      }),
      requestedClientId,
      allowedHost,
    ),
    requestedClientId,
  );
  const response = NextResponse.redirect(toAbsoluteRedirectTarget(target, request));
  response.cookies.set(ACCESS_COOKIE_NAME, newAccessToken, ACCESS_COOKIE_OPTIONS);
  response.cookies.set(REFRESH_COOKIE_NAME, newRefreshToken, REFRESH_COOKIE_OPTIONS);

  console.info("[engram][continue] refresh succeeded; redirecting", { userId: user.id });
  return response;
}
