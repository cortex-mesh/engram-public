import { NextRequest, NextResponse } from "next/server";

import { authenticateRequest } from "@/lib/auth";
import {
  findRegisteredNativeClient,
  issueNativeAuthorizationCode,
  isNativeClientAllowedForApp,
  isValidNativeClientId,
  normalizeNativeRedirectUri,
  validateNativeAppKey,
  validateNativeAuthorizationAdmission,
  validateNativeTenantSlug,
  validatePkceCodeChallenge,
} from "@/lib/native-auth";
import { REDIRECT_TARGET_PARAM, encodeRedirectTarget } from "@/lib/redirect-target";
import { getPublicOrigin } from "@/lib/public-origin";
import { resolveAuthClientForRequest } from "@/lib/auth-host-client";
import { extractRequestedClientIds } from "@/lib/auth-client-config";

function jsonError(error: string, description: string, status: number) {
  return NextResponse.json({ error, error_description: description }, { status });
}

function authorizationCallbackUrl({
  redirectUri,
  code,
  state,
}: {
  redirectUri: string;
  code: string;
  state: string | null;
}) {
  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  if (state) {
    target.searchParams.set("state", state);
  }
  return target;
}

function authorizationErrorCallbackUrl({
  redirectUri,
  error,
  errorDescription,
  state,
}: {
  redirectUri: string;
  error: string;
  errorDescription: string;
  state: string | null;
}) {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  target.searchParams.set("error_description", errorDescription);
  if (state) {
    target.searchParams.set("state", state);
  }
  return target;
}

function isHttpRedirect(url: URL) {
  return url.protocol === "http:" || url.protocol === "https:";
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}

function nativeCompletionPage(
  callbackUrl: string,
  applicationName: string,
  options: { title?: string; message?: string } = {},
) {
  const callbackUrlJson = JSON.stringify(callbackUrl).replace(/</g, "\\u003c");
  const escapedCallbackUrl = escapeHtml(callbackUrl);
  const escapedApplicationName = escapeHtml(applicationName);
  const escapedTitle = escapeHtml(options.title || "Engram sign-in complete");
  const escapedMessage = escapeHtml(
    options.message ||
      `${applicationName} should open automatically. You can close this tab after it opens.`,
  );
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Engram Sign-in Complete</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        align-items: center;
        display: flex;
        justify-content: center;
        margin: 0;
        min-height: 100vh;
      }
      main {
        max-width: 30rem;
        padding: 2rem;
        text-align: center;
      }
      h1 {
        font-size: 1.5rem;
        margin: 0 0 0.75rem;
      }
      p {
        color: color-mix(in srgb, CanvasText 70%, Canvas);
        line-height: 1.5;
        margin: 0 0 1.25rem;
      }
      a {
        color: LinkText;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapedTitle}</h1>
      <p>${escapedMessage}</p>
      <a href="${escapedCallbackUrl}">Open ${escapedApplicationName}</a>
    </main>
    <script>
      window.location.href = ${callbackUrlJson};
    </script>
  </body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function redirectWithError({
  redirectUri,
  error,
  errorDescription,
  state,
  applicationName,
}: {
  redirectUri: string;
  error: string;
  errorDescription: string;
  state: string | null;
  applicationName: string;
}) {
  const target = authorizationErrorCallbackUrl({
    redirectUri,
    error,
    errorDescription,
    state,
  });
  if (!isHttpRedirect(target)) {
    return nativeCompletionPage(target.toString(), applicationName, {
      title: "Engram sign-in could not continue",
      message: `${applicationName} should open automatically with the sign-in result.`,
    });
  }
  return new NextResponse(null, {
    status: 302,
    headers: {
      Location: target.toString(),
      "Referrer-Policy": "no-referrer",
    },
  });
}

function redirectWithCode({
  redirectUri,
  code,
  state,
  applicationName,
}: {
  redirectUri: string;
  code: string;
  state: string | null;
  applicationName: string;
}) {
  const target = authorizationCallbackUrl({ redirectUri, code, state });
  if (!isHttpRedirect(target)) {
    return nativeCompletionPage(target.toString(), applicationName);
  }
  return new NextResponse(null, {
    status: 302,
    headers: {
      Location: target.toString(),
      "Referrer-Policy": "no-referrer",
    },
  });
}

function continueUrl(request: NextRequest, options: { forceLogin?: boolean } = {}) {
  const authorizationUrl = new URL(request.nextUrl);
  if (options.forceLogin) {
    authorizationUrl.searchParams.delete("prompt");
  }
  const authorizationPath = `${authorizationUrl.pathname}${authorizationUrl.search}`;
  const target = new URL("/api/auth/continue", getPublicOrigin(request));
  target.searchParams.set("redirect_uri", authorizationPath);
  target.searchParams.set(REDIRECT_TARGET_PARAM, encodeRedirectTarget(authorizationPath));
  if (options.forceLogin) {
    target.searchParams.set("prompt", "login");
  }
  return target;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const responseType = params.get("response_type");
  const clientId = params.get("client_id");
  const redirectUri = normalizeNativeRedirectUri(params.get("redirect_uri"));
  const codeChallenge = validatePkceCodeChallenge(params.get("code_challenge"));
  const codeChallengeMethod = params.get("code_challenge_method");
  const tenantParam = params.get("tenant");
  const tenantSlug = tenantParam === null ? null : validateNativeTenantSlug(tenantParam);
  const appKey = validateNativeAppKey(params.get("app"));
  const state = params.get("state");
  const forceLogin = params.get("prompt") === "login";

  if (responseType !== "code") {
    return jsonError("invalid_request", "response_type must be code.", 400);
  }
  if (!clientId || !isValidNativeClientId(clientId)) {
    return jsonError("invalid_client", "client_id is not registered.", 400);
  }
  const clientResolution = resolveAuthClientForRequest(
    extractRequestedClientIds(params),
    request.headers,
  );
  if (clientResolution.rejected) {
    return jsonError("invalid_client", "client_id is not allowed on this auth host.", 400);
  }
  if (!redirectUri) {
    return jsonError("invalid_request", "redirect_uri is invalid.", 400);
  }
  if (!codeChallenge || codeChallengeMethod !== "S256") {
    return jsonError(
      "invalid_request",
      "code_challenge and code_challenge_method=S256 are required.",
      400,
    );
  }
  if (tenantParam !== null && !tenantSlug) {
    return jsonError("invalid_request", "tenant is invalid.", 400);
  }
  if (!appKey) {
    return jsonError(
      "invalid_request",
      "app is required for native authorization.",
      400,
    );
  }

  const client = await findRegisteredNativeClient(clientId, redirectUri);
  if (!client) {
    return jsonError("invalid_client", "client_id and redirect_uri are not registered.", 400);
  }
  if (!isNativeClientAllowedForApp(client.clientId, appKey)) {
    return jsonError("invalid_request", "client_id is not allowed for the requested app.", 400);
  }

  if (forceLogin) {
    return NextResponse.redirect(continueUrl(request, { forceLogin: true }));
  }

  const auth = await authenticateRequest(request);
  if (!auth || auth.userId === "internal") {
    return NextResponse.redirect(continueUrl(request));
  }

  if (tenantSlug) {
    const admission = await validateNativeAuthorizationAdmission({
      clientId: client.clientId,
      userId: auth.userId,
      tenantSlug,
      appKey,
    });
    if (!admission.allowed) {
      return redirectWithError({
        redirectUri,
        error: "access_denied",
        errorDescription: "Native authorization is not allowed for this tenant and app.",
        state,
        applicationName: client.displayName,
      });
    }
  }

  const code = await issueNativeAuthorizationCode({
    clientId: client.clientId,
    userId: auth.userId,
    redirectUri,
    codeChallenge,
  });

  return redirectWithCode({
    redirectUri,
    code,
    state,
    applicationName: client.displayName,
  });
}
