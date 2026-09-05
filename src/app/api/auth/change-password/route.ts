import { NextResponse, type NextRequest } from "next/server";
import { authenticateRequest } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hashPassword, verifyPassword } from "@/lib/password";
import { hasCrossOriginCookieWrite } from "@/lib/organizations";
import { recordAuditEvent } from "@/lib/audit";

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Internal-key check first (matches the org/admin mutation routes): an
  // internal service has no "current user" to change a password for.
  if (auth.userId === "internal") {
    return NextResponse.json(
      { error: "Internal API key auth cannot change user passwords." },
      { status: 403 },
    );
  }

  // CSRF: this is a cookie-authenticated state change. Reject cross-site or
  // origin-less cookie writes. Bearer callers carry no cookie and pass
  // (security audit 2026-06-10, #1 + #15).
  if (hasCrossOriginCookieWrite(request)) {
    return NextResponse.json(
      { error: "Cross-site request blocked." },
      { status: 403 },
    );
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
    });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const body = await request.json();
    const { currentPassword, newPassword } = body as {
      currentPassword?: string;
      newPassword: string;
    };

    // Validate newPassword
    if (!newPassword || typeof newPassword !== "string") {
      return NextResponse.json(
        { error: "New password is required" },
        { status: 400 },
      );
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

    if (user.passwordHash) {
      // Changing an existing password requires proving the current one.
      if (!currentPassword) {
        return NextResponse.json(
          { error: "Current password is required" },
          { status: 400 },
        );
      }
      const valid = await verifyPassword(currentPassword, user.passwordHash);
      if (!valid) {
        return NextResponse.json(
          { error: "Current password is incorrect" },
          { status: 401 },
        );
      }
    } else {
      // OAuth-only account: setting an INITIAL password establishes a new
      // persistent credential, so it must not be possible from just a live
      // session (which an attacker could ride). It needs proof of email
      // control, which this endpoint can't provide (security audit
      // 2026-06-10, #1). A dedicated verified-email set-password flow is the
      // intended path and is not built yet; no caller sets passwords here
      // today, so blocking is safe.
      console.warn(
        "[engram][change-password] blocked initial password set for OAuth-only account",
        { userId: auth.userId },
      );
      await recordAuditEvent({
        action: "password.change.blocked_oauth_only",
        outcome: "failure",
        actorUserId: auth.userId,
        targetType: "user",
        targetId: auth.userId,
        reason: "oauth_only_account",
        request,
      });
      return NextResponse.json(
        {
          error:
            "This account uses a linked sign-in provider. Use \"Set a password\" on your account page to add one via email verification.",
        },
        { status: 409 },
      );
    }

    const passwordHash = await hashPassword(newPassword);
    await prisma.user.update({
      where: { id: auth.userId },
      data: { passwordHash },
    });

    // Invalidate all refresh tokens to force re-login on other sessions
    await prisma.refreshToken.deleteMany({
      where: { userId: auth.userId },
    });

    console.info("[engram][change-password] password changed", {
      userId: auth.userId,
    });
    await recordAuditEvent({
      action: "password.change",
      outcome: "success",
      actorUserId: auth.userId,
      targetType: "user",
      targetId: auth.userId,
      request,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Error changing password:", err);
    return NextResponse.json(
      { error: "Failed to change password" },
      { status: 500 },
    );
  }
}
