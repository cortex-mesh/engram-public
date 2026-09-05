import { NextResponse, type NextRequest } from "next/server";
import { getGoogleAuthUrl } from "@/lib/oauth/google";
import { nanoid } from "nanoid";
import { OAUTH_REDIRECT_COOKIE_NAME } from "@/lib/auth-redirect";
import { extractRequestedClientIds, getOAuthCallbackClientPolicy } from "@/lib/auth-client-config";
import { readRedirectTarget } from "@/lib/redirect-target";
import { getAllowedRequestHost, getPublicOrigin } from "@/lib/public-origin";
import { isAllowedHostBoundContinuationTarget, resolveAuthClientForRequest } from "@/lib/auth-host-client";

const OAUTH_CLIENT_COOKIE_NAME = "oauth-client-id";
const OAUTH_PROVIDER_COOKIE_NAME = "oauth-provider";

function clearOAuthContext(response: NextResponse) {
  for (const name of [
    "oauth-state",
    OAUTH_PROVIDER_COOKIE_NAME,
    OAUTH_REDIRECT_COOKIE_NAME,
    OAUTH_CLIENT_COOKIE_NAME,
  ]) {
    response.cookies.set(name, "", { path: "/", maxAge: 0 });
  }
}

export async function GET(request: NextRequest) {
  if (!process.env.ENGRAM_GOOGLE_CLIENT_ID) {
    const response = NextResponse.json(
      { error: "Google OAuth not configured" },
      { status: 501 },
    );
    clearOAuthContext(response);
    return response;
  }

  // Generate state for CSRF protection
  const state = nanoid(24);

  // Build redirect URI from the allowlisted request host. Unknown/spoofed
  // hosts fall back to ENGRAM_URL to preserve the host-header defense.
  const baseUrl = getPublicOrigin(request);
  const redirectUri = `${baseUrl}/api/auth/oauth/google/callback`;

  const authUrl = getGoogleAuthUrl(redirectUri, state);
  const requestedRedirect = readRedirectTarget(request.nextUrl.searchParams);
  const clientResolution = resolveAuthClientForRequest(
    extractRequestedClientIds(request.nextUrl.searchParams),
    request.headers,
  );
  if (clientResolution.rejected) {
    const response = NextResponse.json(
      { error: "client_id is not allowed on this auth host." },
      { status: 400 },
    );
    clearOAuthContext(response);
    return response;
  }
  let clientPolicy;
  try {
    clientPolicy = await getOAuthCallbackClientPolicy(clientResolution.clientId);
  } catch (error) {
    console.error("Google OAuth client configuration error:", error);
    const response = NextResponse.json(
      { error: "Google OAuth is temporarily unavailable." },
      { status: 503 },
    );
    clearOAuthContext(response);
    return response;
  }
  if (!clientPolicy?.authProviders.includes("google")) {
    const response = NextResponse.json(
      { error: "Google OAuth is not enabled for this client." },
      { status: 403 },
    );
    clearOAuthContext(response);
    return response;
  }

  // Set state in cookie for CSRF validation in callback
  const response = NextResponse.redirect(authUrl);
  // Reset all context before writing this flow's state/provider. This prevents
  // omitted redirect/client input from inheriting a prior flow.
  clearOAuthContext(response);
  response.cookies.set("oauth-state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  response.cookies.set(OAUTH_PROVIDER_COOKIE_NAME, "google", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  if (requestedRedirect && await isAllowedHostBoundContinuationTarget(
    requestedRedirect,
    clientResolution.clientId,
    getAllowedRequestHost(request.headers),
  )) {
    response.cookies.set(OAUTH_REDIRECT_COOKIE_NAME, requestedRedirect, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
  }
  if (clientPolicy.clientId) {
    response.cookies.set(OAUTH_CLIENT_COOKIE_NAME, clientPolicy.clientId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
  }

  return response;
}
