import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { validateSignupEmail } from "@/lib/email-hygiene";
import { getEmailSuppression } from "@/lib/email-suppression";
import {
  getEmailIdentityForClient,
  renderWaitlistConfirmationEmail,
  sendEmailBestEffort,
  settleAfter,
} from "@/lib/email";
import { isValidNativeClientId } from "@/lib/native-auth";
import { getPublicOrigin } from "@/lib/public-origin";
import { resolveAuthClientForRequest } from "@/lib/auth-host-client";
import {
  consumeRateLimit,
  getClientIp,
  rateLimitResponse,
} from "@/lib/rate-limit";

function successResponse() {
  return NextResponse.json(
    {
      ok: true,
      message: "Thanks — we received your waitlist request.",
    },
    { status: 202 },
  );
}

function optionalString(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new Error("invalid_string");
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new Error("invalid_string");
  }
  return trimmed || null;
}

function optionalStringArray(value: unknown, maxItems: number, maxItemLength: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error("invalid_array");
  }
  return value.map((item) => {
    if (typeof item !== "string") throw new Error("invalid_array");
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > maxItemLength) throw new Error("invalid_array");
    return trimmed;
  });
}

const IP_LIMIT = 10; // waitlist requests per IP per 15 minutes
const EMAIL_LIMIT = 3; // waitlist requests per target email per 15 minutes
const WINDOW_MS = 15 * 60 * 1000;

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const body = await request.json();
    const { email, displayName, clientId } = body;

    const requestedClientId =
      typeof clientId === "string" && clientId
        ? clientId
        : null;
    const clientResolution = resolveAuthClientForRequest(requestedClientId, request.headers);
    if (clientResolution.rejected) {
      return NextResponse.json({ error: "client_id is not allowed on this auth host." }, { status: 400 });
    }

    // Unauthenticated, and it sends mail to an address the caller chooses.
    // Without a limiter it is both a free mail relay and a cheap oracle to
    // sample; the constant-time floor below also makes each request expensive
    // to serve, so bound them.
    const ipLimit = await consumeRateLimit(
      `waitlist:ip:${getClientIp(request)}`,
      IP_LIMIT,
      WINDOW_MS,
    );
    if (!ipLimit.allowed) {
      return rateLimitResponse(ipLimit.retryAfterSeconds);
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || typeof email !== "string" || !emailRegex.test(email) || email.length > 254) {
      return NextResponse.json(
        { error: "Valid email is required" },
        { status: 400 },
      );
    }

    if (
      displayName !== undefined &&
      (typeof displayName !== "string" || displayName.length > 100)
    ) {
      return NextResponse.json(
        { error: "Display name must be 100 characters or fewer" },
        { status: 400 },
      );
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Keyed on the requested email regardless of account existence, so the
    // limit itself cannot be used as an existence oracle.
    const emailLimit = await consumeRateLimit(
      `waitlist:email:${normalizedEmail}`,
      EMAIL_LIMIT,
      WINDOW_MS,
    );
    if (!emailLimit.allowed) {
      return rateLimitResponse(emailLimit.retryAfterSeconds);
    }

    const trimmedDisplayName = displayName?.trim() || null;
    const normalizedClientId =
      clientResolution.clientId && isValidNativeClientId(clientResolution.clientId)
        ? clientResolution.clientId
        : null;
    let collectionSizeBracket: string | null;
    let formatsPlayed: string[];
    let tradepostGoals: string[];
    let priorityNote: string | null;
    try {
      collectionSizeBracket = optionalString(body.collectionSizeBracket, 40);
      formatsPlayed = optionalStringArray(body.formatsPlayed, 8, 40);
      tradepostGoals = optionalStringArray(body.tradepostGoals, 8, 60);
      priorityNote = optionalString(body.priorityNote, 500);
    } catch {
      return NextResponse.json(
        { error: "Waitlist enrichment fields are invalid" },
        { status: 400 },
      );
    }

    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existingUser) {
      // Already registered: no confirmation mail is sent. Pad to the same
      // floor as the path that does send, or the difference reveals which
      // addresses have accounts (audit N-2).
      await settleAfter(startedAt);
      return successResponse();
    }

    const hygiene = await validateSignupEmail(normalizedEmail);
    const now = new Date();
    const updateData = {
      ...(normalizedClientId ? { clientId: normalizedClientId } : {}),
      ...(trimmedDisplayName ? { displayName: trimmedDisplayName } : {}),
      ...(collectionSizeBracket ? { collectionSizeBracket } : {}),
      ...(formatsPlayed.length > 0 ? { formatsPlayed } : {}),
      ...(tradepostGoals.length > 0 ? { tradepostGoals } : {}),
      ...(priorityNote ? { priorityNote } : {}),
      emailHygieneStatus: hygiene.status,
      emailHygieneReason: hygiene.reason,
      emailHygieneCheckedAt: now,
      confirmationEmailSuppressedAt: hygiene.status === "accepted" ? null : now,
      requestCount: { increment: 1 },
      lastRequestedAt: now,
    };

    const waitlistRequest = await prisma.waitlistRequest.upsert({
      where: { email: normalizedEmail },
      update: updateData,
      create: {
        email: normalizedEmail,
        displayName: trimmedDisplayName,
        clientId: normalizedClientId,
        collectionSizeBracket,
        formatsPlayed,
        tradepostGoals,
        priorityNote,
        emailHygieneStatus: hygiene.status,
        emailHygieneReason: hygiene.reason,
        emailHygieneCheckedAt: now,
        confirmationEmailSuppressedAt: hygiene.status === "accepted" ? null : now,
      },
      select: { id: true },
    });

    if (hygiene.status !== "accepted") {
      console.warn("Waitlist email hygiene rejected confirmation:", {
        email: normalizedEmail,
        status: hygiene.status,
        reason: hygiene.reason,
      });
      await settleAfter(startedAt);
      return successResponse();
    }

    const suppression = await getEmailSuppression(normalizedEmail);
    if (suppression) {
      await prisma.waitlistRequest.update({
        where: { id: waitlistRequest.id },
        data: {
          emailHygieneStatus: "suppressed",
          emailHygieneReason: `${suppression.reason}${suppression.eventType ? ` via ${suppression.eventType}` : ""}`,
          emailHygieneCheckedAt: now,
          confirmationEmailSuppressedAt: now,
        },
      });
      console.warn("Waitlist confirmation suppressed:", {
        email: normalizedEmail,
        reason: suppression.reason,
        eventType: suppression.eventType,
      });
      await settleAfter(startedAt);
      return successResponse();
    }

    const identity = await getEmailIdentityForClient(normalizedClientId);
    const emailPayload = renderWaitlistConfirmationEmail(identity, getPublicOrigin(request));
    await sendEmailBestEffort({
      to: normalizedEmail,
      from: identity.from,
      subject: emailPayload.subject,
      html: emailPayload.html,
      text: emailPayload.text,
    });

    await settleAfter(startedAt);
    return successResponse();
  } catch (error) {
    console.error("Waitlist request failed:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
