import { NextRequest, NextResponse } from "next/server";

import { sha256 } from "@/lib/crypto";
import { generateTokenPair } from "@/lib/jwt";
import {
  NativeAuthValidationError,
  consumeNativeAuthorizationCode,
  findRegisteredNativeClient,
  isValidNativeClientId,
  listNativeAuthorizedTenants,
  nativeAppsForClient,
  normalizeNativeRedirectUri,
} from "@/lib/native-auth";
import { prisma } from "@/lib/prisma";
import { getCanonicalPlatformOrigin } from "@/lib/public-origin";
import { consumeRateLimit, getClientIp } from "@/lib/rate-limit";
import { recordAuditEvent } from "@/lib/audit";
import { resolveAuthClientForRequest } from "@/lib/auth-host-client";
import { extractRequestedClientIds } from "@/lib/auth-client-config";

const IP_LIMIT = 10; // code exchanges per IP per minute
const IP_WINDOW_MS = 60 * 1000;

function errorResponse(error: string, description: string, status = 400) {
  return NextResponse.json({ error, error_description: description }, { status });
}

async function readTokenRequest(request: NextRequest): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    return Object.fromEntries(form.entries());
  }
  return (await request.json()) as Record<string, unknown>;
}

function field(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await readTokenRequest(request);
  } catch {
    return errorResponse("invalid_request", "Request body must be JSON or form data.");
  }

  const grantType = field(body, "grant_type");
  const code = field(body, "code");
  const clientId = field(body, "client_id");
  const redirectUri = normalizeNativeRedirectUri(body.redirect_uri);
  const codeVerifier = field(body, "code_verifier");

  const clientParams = new URLSearchParams();
  clientParams.set("client_id", clientId);
  if (redirectUri) clientParams.set("redirect_uri", redirectUri);
  const clientResolution = resolveAuthClientForRequest(
    extractRequestedClientIds(clientParams),
    request.headers,
  );
  if (clientResolution.rejected) {
    return errorResponse("invalid_client", "client_id is not allowed on this auth host.");
  }

  const ipLimit = await consumeRateLimit(
    `token:ip:${getClientIp(request)}`,
    IP_LIMIT,
    IP_WINDOW_MS,
  );
  if (!ipLimit.allowed) {
    // Keep this route's OAuth error shape (error + error_description);
    // "slow_down" is the RFC 8628 throttling code PKCE clients understand.
    const response = errorResponse(
      "slow_down",
      "Too many token requests. Retry after the indicated delay.",
      429,
    );
    response.headers.set(
      "Retry-After",
      String(Math.max(1, ipLimit.retryAfterSeconds)),
    );
    return response;
  }

  if (grantType !== "authorization_code") {
    return errorResponse("unsupported_grant_type", "grant_type must be authorization_code.");
  }
  if (!code || !clientId || !isValidNativeClientId(clientId) || !redirectUri || !codeVerifier) {
    return errorResponse(
      "invalid_request",
      "code, client_id, redirect_uri, and code_verifier are required.",
    );
  }

  const client = await findRegisteredNativeClient(clientId, redirectUri);
  if (!client) {
    return errorResponse("invalid_client", "client_id and redirect_uri are not registered.");
  }

  try {
    const { userId } = await consumeNativeAuthorizationCode({
      code,
      clientId: client.clientId,
      redirectUri,
      codeVerifier,
    });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, displayName: true, role: true },
    });

    if (!user) {
      return errorResponse("invalid_grant", "Authorization code user no longer exists.");
    }

    const { accessToken, refreshToken } = await generateTokenPair({
      id: user.id,
      displayName: user.displayName,
      role: user.role,
    });
    const [appKey] = nativeAppsForClient(client.clientId);
    const tenants = appKey
      ? await listNativeAuthorizedTenants({
          clientId: client.clientId,
          userId: user.id,
          appKey,
          loginOrigin: getCanonicalPlatformOrigin(),
        })
      : [];

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(refreshToken),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    await recordAuditEvent({
      action: "token.exchange.success",
      outcome: "success",
      actorUserId: user.id,
      targetType: "user",
      targetId: user.id,
      metadata: { clientId: client.clientId },
      request,
    });

    return NextResponse.json({
      accessToken,
      refreshToken,
      tokenType: "Bearer",
      expiresIn: 15 * 60,
      tenants,
    });
  } catch (error) {
    if (error instanceof NativeAuthValidationError) {
      return errorResponse(error.code, error.message);
    }
    console.error("Native token exchange failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
