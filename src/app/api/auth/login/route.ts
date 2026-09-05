import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { burnPasswordVerification, verifyPassword } from "@/lib/password";
import {
  checkRateLimit,
  clearRateLimit,
  consumeRateLimit,
  getClientIp,
  rateLimitResponse,
  recordRateLimitHit,
} from "@/lib/rate-limit";
import {
  generateTokenPair,
  ACCESS_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  ACCESS_COOKIE_OPTIONS,
  REFRESH_COOKIE_OPTIONS,
} from "@/lib/jwt";
import { sha256 } from "@/lib/crypto";
import { getDefaultPostLoginTarget } from "@/lib/apps";
import { withAccountClientContext } from "@/lib/auth-redirect";
import { extractRequestedClientIds, getPublicAuthClientConfig } from "@/lib/auth-client-config";
import { getSafeHostBoundContinuationTarget, resolveAuthClientForRequest } from "@/lib/auth-host-client";
import { getAllowedRequestHost } from "@/lib/public-origin";
import { recordAuditEvent } from "@/lib/audit";

const IP_LIMIT = 10; // attempts per IP per minute
const IP_WINDOW_MS = 60 * 1000;
const FAILURE_LIMIT = 5; // failed attempts per account per 15 minutes
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email, password, redirectUri, preferWorkspace, clientId } = body;
    const clientParams = new URLSearchParams();
    if (typeof clientId === "string") clientParams.set("client_id", clientId);
    if (typeof redirectUri === "string") clientParams.set("redirect_uri", redirectUri);
    const clientResolution = resolveAuthClientForRequest(
      extractRequestedClientIds(clientParams),
      request.headers,
    );
    if (clientResolution.rejected) {
      return NextResponse.json({ error: "client_id is not allowed on this auth host." }, { status: 400 });
    }

    const clientIp = getClientIp(request);
    const ipLimit = await consumeRateLimit(
      `login:ip:${clientIp}`,
      IP_LIMIT,
      IP_WINDOW_MS,
    );
    if (!ipLimit.allowed) {
      return rateLimitResponse(ipLimit.retryAfterSeconds);
    }

    if (!email || !password) {
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401 },
      );
    }

    // Reject overly long passwords (bcrypt limit is 72 bytes)
    if (password.length > 72) {
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401 },
      );
    }

    // Normalize email
    const normalizedEmail = email.trim().toLowerCase();

    // Lock out repeat failures before doing any work. Keyed on email+IP —
    // not email alone — so a remote attacker spraying a victim's email
    // cannot lock the victim out from their own address (lockout-DoS);
    // distributed guessing is still bounded by the per-IP attempt limit.
    const failureKey = `login:fail:${normalizedEmail}:${clientIp}`;
    const failureLimit = await checkRateLimit(failureKey, FAILURE_LIMIT);
    if (!failureLimit.allowed) {
      return rateLimitResponse(failureLimit.retryAfterSeconds);
    }

    // Look up user
    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: {
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
    if (!user || !user.passwordHash) {
      // Burn an equivalent bcrypt compare so unknown accounts cost the same
      // as a wrong password — response timing must not reveal existence.
      await burnPasswordVerification(password);
      await recordRateLimitHit(failureKey, FAILURE_WINDOW_MS);
      // Deliberately do NOT store the attempted email: it may belong to an
      // unregistered third party (typo, enumeration target) and this table is
      // never purged. IP + user-agent identify the attacker for this case.
      await recordAuditEvent({
        action: "login.failure",
        outcome: "failure",
        actorType: "anonymous",
        reason: "no_account",
        request,
      });
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401 },
      );
    }

    // Verify password
    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      await recordRateLimitHit(failureKey, FAILURE_WINDOW_MS);
      await recordAuditEvent({
        action: "login.failure",
        outcome: "failure",
        actorUserId: user.id,
        actorType: "user",
        targetType: "user",
        targetId: user.id,
        reason: "bad_password",
        request,
      });
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401 },
      );
    }

    if (!user.emailVerified) {
      await recordRateLimitHit(failureKey, FAILURE_WINDOW_MS);
      await recordAuditEvent({
        action: "login.failure",
        outcome: "failure",
        actorUserId: user.id,
        actorType: "user",
        targetType: "user",
        targetId: user.id,
        reason: "email_unverified",
        request,
      });
      return NextResponse.json(
        { error: "Verify your email before signing in." },
        { status: 403 },
      );
    }

    // Successful login should not fail solely because the limiter cleanup store is transiently down.
    try {
      await clearRateLimit(failureKey);
    } catch {
      // The next failed login will still consult the counter; do not block a proven password.
    }

    await recordAuditEvent({
      action: "login.success",
      outcome: "success",
      actorUserId: user.id,
      actorType: "user",
      targetType: "user",
      targetId: user.id,
      request,
    });

    // Generate tokens
    const { accessToken, refreshToken } = await generateTokenPair({
      id: user.id,
      displayName: user.displayName,
      role: user.role,
    });

    // Store refresh token hash
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(refreshToken),
        expiresAt,
      },
    });

    const defaultPostLoginTarget = getDefaultPostLoginTarget({
      role: user.role,
      orgMemberships: user.orgMembers,
      preferWorkspace: preferWorkspace === true,
      lastOrgId: user.lastOrgId,
    });

    const clientConfig = await getPublicAuthClientConfig(clientResolution.clientId);
    const postLoginTarget = withAccountClientContext(
      await getSafeHostBoundContinuationTarget(
        redirectUri,
        defaultPostLoginTarget,
        clientResolution.clientId,
        getAllowedRequestHost(request.headers),
      ),
      clientConfig.clientId,
    );

    // Build response with cookies
    const response = NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
      },
      accessToken,
      postLoginTarget,
    });

    response.cookies.set(ACCESS_COOKIE_NAME, accessToken, ACCESS_COOKIE_OPTIONS);
    response.cookies.set(REFRESH_COOKIE_NAME, refreshToken, REFRESH_COOKIE_OPTIONS);

    return response;
  } catch (error) {
    console.error("Login request failed:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
