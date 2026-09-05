import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createMagicLink } from "@/lib/db/magic-links";
import { extractRequestedClientIds } from "@/lib/auth-client-config";
import {
  getEmailIdentityForClient,
  renderMagicLinkEmail,
  sendEmailBestEffort,
  settleAfter,
} from "@/lib/email";
import {
  REDIRECT_TARGET_PARAM,
  encodeRedirectTarget,
} from "@/lib/redirect-target";
import {
  consumeRateLimit,
  getClientIp,
  rateLimitResponse,
} from "@/lib/rate-limit";
import { recordAuditEvent } from "@/lib/audit";
import { getAllowedRequestHost, getPublicOrigin } from "@/lib/public-origin";
import { isAllowedHostBoundContinuationTarget, resolveAuthClientForRequest } from "@/lib/auth-host-client";

const IP_LIMIT = 10; // link requests per IP per 15 minutes
const EMAIL_LIMIT = 3; // link requests per target email per 15 minutes
const WINDOW_MS = 15 * 60 * 1000;

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const { email, redirectUri, clientId: requestedClientId } = await request.json();
    const clientParams = new URLSearchParams();
    if (typeof requestedClientId === "string") clientParams.set("client_id", requestedClientId);
    if (typeof redirectUri === "string") clientParams.set("redirect_uri", redirectUri);
    const clientResolution = resolveAuthClientForRequest(
      extractRequestedClientIds(clientParams),
      request.headers,
    );
    if (clientResolution.rejected) {
      return NextResponse.json({ error: "client_id is not allowed on this auth host." }, { status: 400 });
    }

    const ipLimit = await consumeRateLimit(
      `magiclink:ip:${getClientIp(request)}`,
      IP_LIMIT,
      WINDOW_MS,
    );
    if (!ipLimit.allowed) {
      return rateLimitResponse(ipLimit.retryAfterSeconds);
    }

    if (!email || typeof email !== "string") {
      return NextResponse.json({ error: "Email required" }, { status: 400 });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      return NextResponse.json({ error: "Invalid email" }, { status: 400 });
    }

    // Keyed on the requested email regardless of account existence, so the
    // limit itself can't be used as an existence oracle.
    const emailLimit = await consumeRateLimit(
      `magiclink:email:${normalizedEmail}`,
      EMAIL_LIMIT,
      WINDOW_MS,
    );
    if (!emailLimit.allowed) {
      return rateLimitResponse(emailLimit.retryAfterSeconds);
    }

    // Always return success (don't reveal if email exists)
    const genericResponse = NextResponse.json({
      ok: true,
      message:
        "If an account exists with this email, a login link has been sent",
    });

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (!user) {
      // No account: no email work to do. Pad to the same floor as the path
      // that sends, or the difference enumerates accounts (audit N-2).
      await settleAfter(startedAt);
      return genericResponse;
    }

    // Send throttling is the per-email limiter above — the old DB
    // "recent unexpired link" check silently swallowed sends while the
    // limiter still charged for them, capping users at ~1 real email per
    // window with misleading 429s afterwards.
    const { token } = await createMagicLink(user.id);

    await recordAuditEvent({
      action: "magic_link.issued",
      outcome: "success",
      actorUserId: user.id,
      targetType: "user",
      targetId: user.id,
      request,
    });

    // Build verification URL from the allowlisted request host, falling back
    // to ENGRAM_URL for spoofed or unknown Host/X-Forwarded-Host values.
    const baseUrl = getPublicOrigin(request);
    const clientId = clientResolution.clientId;
    const identity = await getEmailIdentityForClient(clientId);
    const verifyParams = new URLSearchParams({ token });
    if (typeof redirectUri === "string" && await isAllowedHostBoundContinuationTarget(
      redirectUri,
      clientResolution.clientId,
      getAllowedRequestHost(request.headers),
    )) {
      verifyParams.set("redirect_uri", redirectUri);
      verifyParams.set(REDIRECT_TARGET_PARAM, encodeRedirectTarget(redirectUri));
    }
    if (identity.clientId) {
      verifyParams.set("client_id", identity.clientId);
    }
    const verifyUrl = `${baseUrl}/api/auth/magic-link/verify?${verifyParams.toString()}`;
    const emailPayload = renderMagicLinkEmail(identity, verifyUrl);

    // Awaited: a floating promise is dropped on Lambda (frozen on response).
    // The response is padded to a constant floor below so that awaiting does
    // not re-open the timing oracle this used to avoid (audit N-2).
    await sendEmailBestEffort({
      to: normalizedEmail,
      from: identity.from,
      subject: emailPayload.subject,
      html: emailPayload.html,
      text: emailPayload.text,
    });

    await settleAfter(startedAt);
    return genericResponse;
  } catch (err) {
    console.error("Magic link request error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
