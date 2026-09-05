import { NextRequest, NextResponse } from "next/server";

import { authenticateRequest } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createMagicLink } from "@/lib/db/magic-links";
import { hasCrossOriginCookieWrite } from "@/lib/organizations";
import {
  getEmailIdentityForClient,
  renderSetPasswordEmail,
  sendEmailBestEffort,
} from "@/lib/email";
import { extractRequestedClientIds } from "@/lib/auth-client-config";
import { getPublicOrigin } from "@/lib/public-origin";
import {
  consumeRateLimit,
  getClientIp,
  rateLimitResponse,
} from "@/lib/rate-limit";
import { recordAuditEvent } from "@/lib/audit";
import { buildSetPasswordUrl } from "@/lib/set-password-url";
import { resolveAuthClientForRequest } from "@/lib/auth-host-client";

const IP_LIMIT = 5; // set-password link requests per IP per 15 minutes
const WINDOW_MS = 15 * 60 * 1000;

async function readRequestedClientIds(request: NextRequest): Promise<string[]> {
  const params = new URLSearchParams(request.nextUrl.searchParams);

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return extractRequestedClientIds(params);
  }

  try {
    const body = (await request.json()) as {
      client_id?: unknown;
      clientId?: unknown;
    };
    const bodyClientId = body.client_id ?? body.clientId;
    if (typeof bodyClientId === "string") params.set("client_id", bodyClientId);
  } catch {
    return extractRequestedClientIds(params);
  }
  return extractRequestedClientIds(params);
}

// Authenticated user requests a verified-email set-password link to their own
// address (ADR-017). Establishing a password requires proof of email control
// at set time, which the emailed token provides; the live session alone is
// not sufficient (that is the credential-persistence vector HG-3 closed).
export async function POST(request: NextRequest) {
  const clientResolution = resolveAuthClientForRequest(
    await readRequestedClientIds(request),
    request.headers,
  );
  if (clientResolution.rejected) {
    return NextResponse.json({ error: "client_id is not allowed on this auth host." }, { status: 400 });
  }

  const ipLimit = await consumeRateLimit(
    `setpw:ip:${getClientIp(request)}`,
    IP_LIMIT,
    WINDOW_MS,
  );
  if (!ipLimit.allowed) {
    return rateLimitResponse(ipLimit.retryAfterSeconds);
  }

  const auth = await authenticateRequest(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (auth.userId === "internal") {
    return NextResponse.json(
      { error: "Internal API key auth cannot request a set-password link." },
      { status: 403 },
    );
  }
  // CSRF: cookie-authenticated mutation (bearer/internal carry no cookie).
  if (hasCrossOriginCookieWrite(request)) {
    return NextResponse.json(
      { error: "Cross-site request blocked." },
      { status: 403 },
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    select: { id: true, email: true },
  });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { token } = await createMagicLink(user.id, "set_password");
  const identity = await getEmailIdentityForClient(clientResolution.clientId);
  const setUrl = buildSetPasswordUrl(getPublicOrigin(request), token, identity.clientId);
  const emailPayload = renderSetPasswordEmail(identity, setUrl);

  // No settleAfter here: this route is authenticated, so the caller already
  // holds the session for the account and there is no existence to leak.
  await sendEmailBestEffort({
    to: user.email,
    from: identity.from,
    subject: emailPayload.subject,
    html: emailPayload.html,
    text: emailPayload.text,
  });

  await recordAuditEvent({
    action: "password.set.requested",
    outcome: "success",
    actorUserId: user.id,
    targetType: "user",
    targetId: user.id,
    request,
  });

  return NextResponse.json({
    ok: true,
    message: "A set-password link has been sent to your email.",
  });
}
