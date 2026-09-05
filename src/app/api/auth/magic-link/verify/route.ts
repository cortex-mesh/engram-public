import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { consumeMagicLink } from "@/lib/db/magic-links";
import {
  generateTokenPair,
  ACCESS_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  ACCESS_COOKIE_OPTIONS,
  REFRESH_COOKIE_OPTIONS,
} from "@/lib/jwt";
import { sha256 } from "@/lib/crypto";
import { toAbsoluteRedirectTarget, withAccountClientContext } from "@/lib/auth-redirect";
import { extractRequestedClientIds, getPublicAuthClientConfig } from "@/lib/auth-client-config";
import { getDefaultPostLoginTarget } from "@/lib/apps";
import { recordAuditEvent } from "@/lib/audit";
import { getAllowedRequestHost, getPublicOrigin } from "@/lib/public-origin";
import {
  getSafeHostBoundContinuationTarget,
  isAllowedHostBoundContinuationTarget,
  resolveAuthClientForRequest,
} from "@/lib/auth-host-client";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * GET renders a confirmation interstitial instead of consuming the token
 * (audit N-5). Email link-scanners / prefetchers issue a GET and neither POST
 * nor run scripts, so they can no longer silently burn the one-time link, and
 * a session can no longer be minted by a bare cross-site GET navigation. The
 * actual consumption + session mint happens on the same-origin POST below.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  const redirectUri = request.nextUrl.searchParams.get("redirect_uri");
  const clientResolution = resolveAuthClientForRequest(
    extractRequestedClientIds(request.nextUrl.searchParams),
    request.headers,
  );
  const baseUrl = getPublicOrigin(request);

  if (clientResolution.rejected) {
    return NextResponse.redirect(new URL("/?error=invalid_client", baseUrl));
  }
  const clientId = clientResolution.clientId;

  if (!token) {
    return NextResponse.redirect(new URL("/?error=missing_token", baseUrl));
  }

  // Only echo a redirect_uri we would actually honor, and HTML-escape every
  // value interpolated into the page.
  const safeRedirect = await isAllowedHostBoundContinuationTarget(
    redirectUri,
    clientId,
    getAllowedRequestHost(request.headers),
  ) ? redirectUri || "" : "";
  const action = `${baseUrl}/api/auth/magic-link/verify`;
  const clientConfig = await getPublicAuthClientConfig(clientId);
  const signInBrand = escapeHtml(clientConfig.brandName);

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in to ${signInBrand}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:24rem;margin:6rem auto;padding:0 1rem;text-align:center;color:#111}button{font:inherit;padding:.75rem 1.5rem;border:0;border-radius:.5rem;background:#111;color:#fff;cursor:pointer}</style>
</head><body>
<h1>Sign in to ${signInBrand}</h1>
<p>Click below to finish signing in.</p>
<form method="POST" action="${escapeHtml(action)}">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<input type="hidden" name="redirect_uri" value="${escapeHtml(safeRedirect)}">
<input type="hidden" name="client_id" value="${escapeHtml(clientId || "")}">
<button type="submit">Continue to sign in</button>
</form>
</body></html>`;

  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

// The POST must originate from our own interstitial. A cross-site
// auto-submitting form could otherwise log a victim into the attacker's
// account (login CSRF), so reject anything that isn't same-origin. Browsers
// that omit Sec-Fetch-Site (old) fall back to an Origin check.
function isSameOriginPost(request: NextRequest): boolean {
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite) {
    return secFetchSite === "same-origin" || secFetchSite === "none";
  }
  const origin = request.headers.get("origin");
  if (!origin) return true; // no Origin and no Sec-Fetch-Site → old browser, allow
  const expected = getPublicOrigin(request);
  try {
    return new URL(origin).origin === new URL(expected).origin;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const baseUrl = getPublicOrigin(request);

  if (!isSameOriginPost(request)) {
    return NextResponse.redirect(new URL("/?error=invalid_link", baseUrl), 303);
  }

  let token: string | null = null;
  let redirectUri: string | null = null;
  let clientId: string | null = null;
  try {
    const form = await request.formData();
    const t = form.get("token");
    const r = form.get("redirect_uri");
    const c = form.get("client_id");
    token = typeof t === "string" ? t : null;
    redirectUri = typeof r === "string" ? r : null;
    const params = new URLSearchParams();
    if (typeof c === "string") params.set("client_id", c);
    if (redirectUri) params.set("redirect_uri", redirectUri);
    const clientResolution = resolveAuthClientForRequest(
      extractRequestedClientIds(params),
      request.headers,
    );
    if (clientResolution.rejected) {
      return NextResponse.redirect(new URL("/?error=invalid_client", baseUrl), 303);
    }
    clientId = clientResolution.clientId;
  } catch {
    // No form body — treated as missing token below.
  }

  if (!token) {
    return NextResponse.redirect(new URL("/?error=missing_token", baseUrl), 303);
  }

  try {
    const { valid, userId, reason } = await consumeMagicLink(token);

    if (!valid || !userId) {
      const errorParam =
        reason === "expired"
          ? "link_expired"
          : reason === "already_used"
            ? "link_used"
            : "invalid_link";
      return NextResponse.redirect(new URL(`/?error=${errorParam}`, baseUrl), 303);
    }

    // Look up user for role
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        emailVerified: true,
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

    // Mark email as verified
    if (user && !user.emailVerified) {
      await prisma.user.update({
        where: { id: userId },
        data: { emailVerified: true },
      });
    }

    // Generate JWT pair
    const { accessToken, refreshToken } = await generateTokenPair({
      id: userId,
      displayName: user?.displayName,
      role: user?.role,
    });

    // Store refresh token
    await prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: sha256(refreshToken),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    await recordAuditEvent({
      action: "magic_link.consumed",
      outcome: "success",
      actorUserId: userId,
      targetType: "user",
      targetId: userId,
      request,
    });

    // Set cookies and redirect (validate redirect_uri to prevent open redirect).
    // 303 so the browser GETs the destination rather than re-POSTing.
    const destination = withAccountClientContext(
      await getSafeHostBoundContinuationTarget(
        redirectUri,
        getDefaultPostLoginTarget({
          role: user?.role,
          orgMemberships: user?.orgMembers,
          lastOrgId: user?.lastOrgId,
        }),
        clientId,
        getAllowedRequestHost(request.headers),
      ),
      clientId,
    );
    const response = NextResponse.redirect(
      toAbsoluteRedirectTarget(destination, baseUrl),
      303,
    );

    response.cookies.set(ACCESS_COOKIE_NAME, accessToken, ACCESS_COOKIE_OPTIONS);
    response.cookies.set(REFRESH_COOKIE_NAME, refreshToken, REFRESH_COOKIE_OPTIONS);
    response.headers.set("Referrer-Policy", "no-referrer");

    return response;
  } catch (err) {
    console.error("Magic link verify error:", err);
    return NextResponse.redirect(new URL("/?error=internal", baseUrl), 303);
  }
}
