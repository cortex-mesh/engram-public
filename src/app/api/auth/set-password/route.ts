import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import { consumeMagicLink } from "@/lib/db/magic-links";
import { getPublicOrigin } from "@/lib/public-origin";
import { recordAuditEvent } from "@/lib/audit";

// The set-password form on /set-password (same-origin) POSTs here. Require a
// same-origin request so a cross-site page can't drive the submit.
function isSameOriginPost(request: NextRequest): boolean {
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite) {
    return secFetchSite === "same-origin" || secFetchSite === "none";
  }
  const origin = request.headers.get("origin");
  if (!origin) return true; // no signals → old client, allow
  const expected = getPublicOrigin(request);
  try {
    return new URL(origin).origin === new URL(expected).origin;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOriginPost(request)) {
    return NextResponse.json({ error: "Cross-site request blocked." }, { status: 403 });
  }

  let token: string | undefined;
  let newPassword: string | undefined;
  try {
    const body = (await request.json()) as { token?: string; newPassword?: string };
    token = typeof body.token === "string" ? body.token : undefined;
    newPassword = typeof body.newPassword === "string" ? body.newPassword : undefined;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 400 });
  }
  if (!newPassword) {
    return NextResponse.json({ error: "New password is required" }, { status: 400 });
  }
  if (newPassword.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters" },
      { status: 400 },
    );
  }
  if (newPassword.length > 72) {
    return NextResponse.json(
      { error: "Password must be at most 72 characters" },
      { status: 400 },
    );
  }
  if (newPassword.trim().length === 0) {
    return NextResponse.json(
      { error: "Password cannot be only whitespace" },
      { status: 400 },
    );
  }

  // Consume the set-password token — proves email control at set time, and
  // can't be a login link (purpose-bound, single-use, 15-min TTL).
  const { valid, userId, reason } = await consumeMagicLink(token, "set_password");
  if (!valid || !userId) {
    const message =
      reason === "expired"
        ? "This link has expired. Request a new one."
        : reason === "already_used"
          ? "This link has already been used."
          : "This link is invalid.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const passwordHash = await hashPassword(newPassword);

  // Set the password, mark the email verified (the link proved control), and
  // revoke every existing session so the new credential takes over cleanly.
  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { passwordHash, emailVerified: true },
    }),
    prisma.refreshToken.deleteMany({ where: { userId } }),
  ]);

  await recordAuditEvent({
    action: "password.set",
    outcome: "success",
    actorUserId: userId,
    targetType: "user",
    targetId: userId,
    request,
  });

  return NextResponse.json({ ok: true });
}
