import { NextResponse, type NextRequest } from "next/server";
import { exchangeGoogleCode, getGoogleUser } from "@/lib/oauth/google";
import { findOrCreateOAuthUser } from "@/lib/db/oauth-accounts";
import {
  generateTokenPair,
  ACCESS_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  ACCESS_COOKIE_OPTIONS,
  REFRESH_COOKIE_OPTIONS,
} from "@/lib/jwt";
import { sha256 } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import {
  OAUTH_REDIRECT_COOKIE_NAME,
  toAbsoluteRedirectTarget,
  withAccountClientContext,
} from "@/lib/auth-redirect";
import { getDefaultPostLoginTarget } from "@/lib/apps";
import {
  extractClientIdsFromContinuation,
  getOAuthCallbackClientPolicy,
} from "@/lib/auth-client-config";
import { getAllowedRequestHost, getPublicOrigin } from "@/lib/public-origin";
import { getSafeHostBoundContinuationTarget, resolveAuthClientForRequest } from "@/lib/auth-host-client";

const OAUTH_CLIENT_COOKIE_NAME = "oauth-client-id";
const OAUTH_PROVIDER_COOKIE_NAME = "oauth-provider";

function buildWaitlistRedirect(baseUrl: string, email?: string | null, clientId?: string | null) {
  const params = new URLSearchParams({ error: "waitlist_required" });
  if (email) {
    params.set("email", email);
  }
  if (clientId) {
    params.set("client_id", clientId);
  }
  return new URL(`/register?${params.toString()}`, baseUrl);
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const storedState = request.cookies.get("oauth-state")?.value;
  const storedRedirect = request.cookies.get(OAUTH_REDIRECT_COOKIE_NAME)?.value;
  const storedClientId = request.cookies.get(OAUTH_CLIENT_COOKIE_NAME)?.value;
  const storedProvider = request.cookies.get(OAUTH_PROVIDER_COOKIE_NAME)?.value;

  const baseUrl = getPublicOrigin(request);

  const errorRedirect = (err: string) => {
    const response = NextResponse.redirect(
      new URL(`/?error=${err}`, baseUrl),
    );
    response.cookies.set("oauth-state", "", { path: "/", maxAge: 0 });
    response.cookies.set(OAUTH_PROVIDER_COOKIE_NAME, "", { path: "/", maxAge: 0 });
    response.cookies.set(OAUTH_REDIRECT_COOKIE_NAME, "", { path: "/", maxAge: 0 });
    response.cookies.set(OAUTH_CLIENT_COOKIE_NAME, "", { path: "/", maxAge: 0 });
    return response;
  };

  // CSRF check
  if (!code || !state || !storedState || state !== storedState || storedProvider !== "google") {
    return errorRedirect("oauth_invalid_state");
  }
  const clientResolution = resolveAuthClientForRequest(
    [...extractClientIdsFromContinuation(storedRedirect), storedClientId],
    request.headers,
  );
  if (clientResolution.rejected) {
    return errorRedirect("oauth_invalid_client");
  }
  let clientPolicy;
  try {
    clientPolicy = await getOAuthCallbackClientPolicy(clientResolution.clientId);
  } catch (error) {
    console.error("Google OAuth client policy error:", error);
    return errorRedirect("oauth_invalid_client");
  }
  if (!clientPolicy?.authProviders.includes("google")) {
    return errorRedirect("oauth_invalid_client");
  }

  try {
    const redirectUri = `${baseUrl}/api/auth/oauth/google/callback`;

    // Exchange code for token
    const { accessToken: googleToken } = await exchangeGoogleCode(
      code,
      redirectUri,
    );

    // Get Google user info
    const googleUser = await getGoogleUser(googleToken);
    // Find an existing allowed user
    const oauthResult = await findOrCreateOAuthUser({
      provider: "google",
      providerAccountId: String(googleUser.id),
      email: googleUser.email,
      emailVerified: googleUser.emailVerified,
      displayName: googleUser.name,
      avatarUrl: googleUser.picture,
      allowCreate: clientPolicy.signupMode === "open",
    });

    if (!oauthResult) {
      const response = NextResponse.redirect(
        buildWaitlistRedirect(baseUrl, googleUser.email, clientPolicy.clientId),
      );
      response.cookies.set("oauth-state", "", { path: "/", maxAge: 0 });
      response.cookies.set(OAUTH_PROVIDER_COOKIE_NAME, "", { path: "/", maxAge: 0 });
      response.cookies.set(OAUTH_REDIRECT_COOKIE_NAME, "", { path: "/", maxAge: 0 });
      response.cookies.set(OAUTH_CLIENT_COOKIE_NAME, "", { path: "/", maxAge: 0 });
      return response;
    }

    const { user: rawUser } = oauthResult;
    const linkedUser = rawUser as { id: string; role?: string };
    const user = await prisma.user.findUnique({
      where: { id: linkedUser.id },
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
      return errorRedirect("oauth_failed");
    }

    // Generate JWT pair
    const { accessToken, refreshToken } = await generateTokenPair({
      id: user.id,
      displayName: user.displayName,
      role: user.role,
    });

    // Store refresh token
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(refreshToken),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    // Set cookies and redirect
    const destination = withAccountClientContext(
      await getSafeHostBoundContinuationTarget(
        storedRedirect,
        getDefaultPostLoginTarget({
          role: user.role,
          orgMemberships: user.orgMembers,
          lastOrgId: user.lastOrgId,
        }),
        clientPolicy.clientId,
        getAllowedRequestHost(request.headers),
      ),
      clientPolicy.clientId,
    );
    const response = NextResponse.redirect(toAbsoluteRedirectTarget(destination, baseUrl));
    response.cookies.set(ACCESS_COOKIE_NAME, accessToken, ACCESS_COOKIE_OPTIONS);
    response.cookies.set(REFRESH_COOKIE_NAME, refreshToken, REFRESH_COOKIE_OPTIONS);
    // Clear oauth cookies
    response.cookies.set("oauth-state", "", { path: "/", maxAge: 0 });
    response.cookies.set(OAUTH_PROVIDER_COOKIE_NAME, "", { path: "/", maxAge: 0 });
    response.cookies.set(OAUTH_REDIRECT_COOKIE_NAME, "", { path: "/", maxAge: 0 });
    response.cookies.set(OAUTH_CLIENT_COOKIE_NAME, "", { path: "/", maxAge: 0 });

    return response;
  } catch (err) {
    console.error("Google OAuth error:", err);
    return errorRedirect("oauth_failed");
  }
}
