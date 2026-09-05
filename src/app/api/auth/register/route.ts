import { NextRequest, NextResponse } from "next/server";

import { createMagicLink } from "@/lib/db/magic-links";
import {
  getEmailIdentityForClient,
  renderVerifyEmail,
  sendEmailRequired,
  settleAfter,
} from "@/lib/email";
import { hashPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import { getPublicOrigin } from "@/lib/public-origin";
import { generateUniqueUsername } from "@/lib/usernames";
import { getPublicAuthClientConfig } from "@/lib/auth-client-config";
import { validateSignupEmail } from "@/lib/email-hygiene";
import { getEmailSuppression } from "@/lib/email-suppression";
import { isValidNativeClientId } from "@/lib/native-auth";
import { resolveAuthClientForRequest } from "@/lib/auth-host-client";
import { recordAuditEvent } from "@/lib/audit";
import {
  consumeRateLimit,
  getClientIp,
  rateLimitResponse,
} from "@/lib/rate-limit";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IP_LIMIT = 10; // registration attempts per IP per 15 minutes
const WINDOW_MS = 15 * 60 * 1000;

function validPassword(value: string): boolean {
  return value.length >= 8 && value.length <= 72 && value.trim().length > 0;
}

function successResponse() {
  return NextResponse.json(
    {
      ok: true,
      message: "Check your email to verify your account before signing in.",
    },
    { status: 202 },
  );
}

function isEmailUniqueConstraintError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (!("code" in error) || error.code !== "P2002") return false;
  const meta = "meta" in error ? error.meta : undefined;
  if (typeof meta !== "object" || meta === null || !("target" in meta)) {
    return false;
  }
  const target = meta.target;
  if (Array.isArray(target)) return target.includes("email");
  return typeof target === "string" && target.includes("email");
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  let body: {
    email?: unknown;
    displayName?: unknown;
    password?: unknown;
    clientId?: unknown;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const requestedClientId =
    typeof body.clientId === "string" && body.clientId
      ? body.clientId
      : null;
  const clientResolution = resolveAuthClientForRequest(requestedClientId, request.headers);
  if (clientResolution.rejected) {
    return NextResponse.json({ error: "client_id is not allowed on this auth host." }, { status: 400 });
  }
  const clientId =
    clientResolution.clientId && isValidNativeClientId(clientResolution.clientId)
      ? clientResolution.clientId
      : null;

  const ipLimit = await consumeRateLimit(
    `register:ip:${getClientIp(request)}`,
    IP_LIMIT,
    WINDOW_MS,
  );
  if (!ipLimit.allowed) {
    return rateLimitResponse(ipLimit.retryAfterSeconds);
  }
  const clientConfig = await getPublicAuthClientConfig(clientId);
  if (clientConfig.signupMode !== "open") {
    return NextResponse.json(
      {
        error:
          "Self-service account creation is disabled. Request waitlist access instead.",
      },
      { status: 403 },
    );
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || !EMAIL_REGEX.test(email) || email.length > 254 || !validPassword(password)) {
    return NextResponse.json(
      { error: "A valid email and password are required." },
      { status: 400 },
    );
  }
  if (displayName.length > 100) {
    return NextResponse.json(
      { error: "Display name must be 100 characters or fewer." },
      { status: 400 },
    );
  }

  const hygiene = await validateSignupEmail(email);
  if (hygiene.status !== "accepted") {
    console.warn("Registration email hygiene rejected verification:", {
      email,
      status: hygiene.status,
      reason: hygiene.reason,
    });
    await settleAfter(startedAt);
    return successResponse();
  }

  if (!process.env.RESEND_API_KEY) {
    console.error("Self-service registration is missing RESEND_API_KEY; returning generic response.");
    await settleAfter(startedAt);
    return successResponse();
  }

  const suppression = await getEmailSuppression(email);
  if (suppression) {
    console.warn("Registration email suppression blocked verification:", {
      email,
      reason: suppression.reason,
      eventType: suppression.eventType,
    });
    await settleAfter(startedAt);
    return successResponse();
  }

  const existingUser = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (existingUser) {
    await settleAfter(startedAt);
    return successResponse();
  }

  try {
    const username = await generateUniqueUsername(email);
    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: {
        email,
        username,
        displayName: displayName || null,
        passwordHash,
        emailVerified: false,
        role: "USER",
      },
      select: { id: true, email: true },
    });

    const { token } = await createMagicLink(user.id, "verify_email");
    const verifyUrl = `${getPublicOrigin(request)}/api/auth/verify-email?token=${token}`;
    const identity = await getEmailIdentityForClient(clientConfig.clientId);
    const emailPayload = renderVerifyEmail(identity, verifyUrl);

    await sendEmailRequired({
      to: user.email,
      from: identity.from,
      subject: emailPayload.subject,
      html: emailPayload.html,
      text: emailPayload.text,
    });

    await recordAuditEvent({
      action: "magic_link.issued",
      outcome: "success",
      actorUserId: user.id,
      targetType: "user",
      targetId: user.id,
      metadata: { purpose: "verify_email", clientId: clientConfig.clientId },
      request,
    });

    await settleAfter(startedAt);
    return successResponse();
  } catch (error) {
    if (isEmailUniqueConstraintError(error)) {
      await settleAfter(startedAt);
      return successResponse();
    }
    console.error("Self-service registration failed:", error);
    return NextResponse.json({ error: "Registration failed." }, { status: 500 });
  }
}
