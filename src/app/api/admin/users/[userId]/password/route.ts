import { randomBytes } from "crypto";
import { NextResponse, type NextRequest } from "next/server";

import { authenticateRequest, isCurrentPlatformSuperadmin } from "@/lib/auth";
import { isPlatformSuperadmin } from "@/lib/authorization";
import { hasCrossOriginCookieWrite } from "@/lib/organizations";
import { hashPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import { recordAuditEvent } from "@/lib/audit";

interface RouteContext {
  params: Promise<{ userId: string }>;
}

function forbiddenResponse() {
  return NextResponse.json(
    { error: "Only platform superadmins can manage users." },
    { status: 403 },
  );
}

function generateTemporaryPassword(): string {
  return randomBytes(18).toString("base64url");
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await authenticateRequest(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (auth.userId === "internal") {
    return NextResponse.json(
      { error: "Internal API key auth is not allowed for user management." },
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

  const { userId } = await context.params;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      username: true,
      displayName: true,
      role: true,
    },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }

  if (isPlatformSuperadmin(user.role)) {
    return NextResponse.json(
      { error: "Platform superadmin passwords cannot be reset from this admin flow." },
      { status: 400 },
    );
  }

  try {
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { passwordHash },
      }),
      prisma.refreshToken.deleteMany({
        where: { userId },
      }),
    ]);

    await recordAuditEvent({
      action: "admin.password.reset",
      outcome: "success",
      actorUserId: auth.userId,
      actorType: "admin",
      targetType: "user",
      targetId: userId,
      request,
    });

    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        displayName: user.displayName || user.username,
        role: user.role,
      },
      temporaryPassword,
    });
  } catch (error) {
    console.error("Failed to reset admin-managed user password:", error);
    return NextResponse.json({ error: "Failed to reset password." }, { status: 500 });
  }
}
