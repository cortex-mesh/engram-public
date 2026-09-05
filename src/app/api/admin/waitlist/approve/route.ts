import { NextRequest, NextResponse } from "next/server";

import { authenticateRequest, isCurrentPlatformSuperadmin } from "@/lib/auth";
import { createMagicLink } from "@/lib/db/magic-links";
import {
  getEmailIdentityForClient,
  renderApprovalSetPasswordEmail,
  sendEmailRequired,
} from "@/lib/email";
import { hasCrossOriginCookieWrite, isUniqueConstraintError } from "@/lib/organizations";
import { prisma } from "@/lib/prisma";
import { getPublicOrigin } from "@/lib/public-origin";
import { buildSetPasswordUrl } from "@/lib/set-password-url";
import { generateUniqueUsername } from "@/lib/usernames";
import { recordAuditEvent } from "@/lib/audit";
import { getEmailSuppression } from "@/lib/email-suppression";

const MAX_BATCH = 50;

function forbiddenResponse() {
  return NextResponse.json(
    { error: "Only platform superadmins can approve waitlist requests." },
    { status: 403 },
  );
}

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (auth.userId === "internal") {
    return NextResponse.json(
      { error: "Internal API key auth is not allowed for waitlist approval." },
      { status: 403 },
    );
  }
  if (hasCrossOriginCookieWrite(request)) {
    return NextResponse.json(
      { error: "Cross-origin cookie-authenticated writes are not allowed." },
      { status: 403 },
    );
  }
  if (!(await isCurrentPlatformSuperadmin(auth))) {
    return forbiddenResponse();
  }
  if (!process.env.RESEND_API_KEY) {
    return NextResponse.json(
      { error: "Waitlist approval is pending a configured email provider." },
      { status: 503 },
    );
  }

  let body: { ids?: unknown; confirmEmails?: unknown };
  try {
    body = (await request.json()) as { ids?: unknown; confirmEmails?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const ids = Array.isArray(body.ids)
    ? body.ids.filter((value): value is string => typeof value === "string")
    : [];
  const confirmEmails = Array.isArray(body.confirmEmails)
    ? body.confirmEmails
        .filter((value): value is string => typeof value === "string")
        .map((email) => email.trim().toLowerCase())
    : [];
  const uniqueIds = Array.from(new Set(ids));
  if (uniqueIds.length === 0) {
    return NextResponse.json({ error: "At least one request id is required." }, { status: 400 });
  }
  if (uniqueIds.length > MAX_BATCH) {
    return NextResponse.json(
      { error: `Approval batches are capped at ${MAX_BATCH} people. Select fewer rows and try again.` },
      { status: 400 },
    );
  }
  if (confirmEmails.length !== uniqueIds.length) {
    return NextResponse.json(
      { error: "Approval requires confirming the exact email recipients." },
      { status: 400 },
    );
  }

  const requests = await prisma.waitlistRequest.findMany({
    where: { id: { in: uniqueIds }, approvedAt: null, hiddenAt: null },
    orderBy: { createdAt: "asc" },
  });
  const requestEmails = requests.map((waitlistRequest) => waitlistRequest.email.toLowerCase()).sort();
  const expectedEmails = [...new Set(confirmEmails)].sort();
  if (requestEmails.length !== uniqueIds.length || requestEmails.length !== expectedEmails.length) {
    return NextResponse.json(
      { error: "Approval recipients changed. Refresh the queue and confirm again." },
      { status: 409 },
    );
  }
  if (requestEmails.some((email, index) => email !== expectedEmails[index])) {
    return NextResponse.json(
      { error: "Approval recipients do not match the confirmed email list." },
      { status: 409 },
    );
  }

  let approved = 0;
  for (const waitlistRequest of requests) {
    try {
      const suppression = await getEmailSuppression(waitlistRequest.email);
      if (suppression || waitlistRequest.emailHygieneStatus !== "accepted") {
        await prisma.waitlistRequest.update({
          where: { id: waitlistRequest.id },
          data: {
            emailHygieneStatus: suppression ? "suppressed" : waitlistRequest.emailHygieneStatus,
            emailHygieneReason: suppression
              ? `${suppression.reason}${suppression.eventType ? ` via ${suppression.eventType}` : ""}`
              : waitlistRequest.emailHygieneReason,
            confirmationEmailSuppressedAt: new Date(),
          },
        });
        return NextResponse.json(
          { error: "A selected request has a blocked email address.", approved },
          { status: 409 },
        );
      }

      const existingUser = await prisma.user.findUnique({
        where: { email: waitlistRequest.email },
        select: { id: true, email: true },
      });
      const user =
        existingUser ||
        (await prisma.user.create({
          data: {
            email: waitlistRequest.email,
            username: await generateUniqueUsername(waitlistRequest.email),
            displayName: waitlistRequest.displayName,
            emailVerified: false,
            role: "USER",
          },
          select: { id: true, email: true },
        }));

      const { token } = await createMagicLink(user.id, "set_password");
      const setUrl = buildSetPasswordUrl(getPublicOrigin(request), token, waitlistRequest.clientId);
      const identity = await getEmailIdentityForClient(waitlistRequest.clientId);
      const emailPayload = renderApprovalSetPasswordEmail(identity, setUrl);
      await sendEmailRequired({
        to: user.email,
        from: identity.from,
        subject: emailPayload.subject,
        html: emailPayload.html,
        text: emailPayload.text,
      });

      await prisma.waitlistRequest.update({
        where: { id: waitlistRequest.id },
        data: {
          approvedAt: new Date(),
          approvedByUserId: auth.userId,
          approvalEmailSentAt: new Date(),
        },
      });

      await recordAuditEvent({
        action: "waitlist.approve",
        outcome: "success",
        actorUserId: auth.userId,
        actorType: "admin",
        targetType: "user",
        targetId: user.id,
        metadata: {
          waitlistRequestId: waitlistRequest.id,
          clientId: waitlistRequest.clientId,
        },
        request,
      });

      approved += 1;
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        console.error("Waitlist approval failed:", error);
      }
      return NextResponse.json(
        { error: "Waitlist approval failed before the batch completed.", approved },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({ ok: true, approved });
}
