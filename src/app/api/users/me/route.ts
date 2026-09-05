import { NextResponse, type NextRequest } from "next/server";
import { authenticateRequest } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasCrossOriginCookieWrite } from "@/lib/organizations";

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
    });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const oauthAccounts = await prisma.oAuthAccount.findMany({
      where: { userId: auth.userId },
      select: { provider: true, providerAccountId: true },
    });

    return NextResponse.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        emailVerified: user.emailVerified,
        avatarUrl: user.avatarUrl,
        role: user.role,
        createdAt: user.createdAt,
        hasPassword: !!user.passwordHash,
      },
      oauthAccounts,
    });
  } catch (err) {
    console.error("DB error fetching user profile:", err);
    return NextResponse.json(
      { error: "Failed to fetch user profile" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // CSRF: cookie-authenticated profile write — same guard the other
  // cookie-auth mutations carry. Bearer/internal callers pass (no cookie).
  if (hasCrossOriginCookieWrite(request)) {
    return NextResponse.json(
      { error: "Cross-site request blocked." },
      { status: 403 },
    );
  }

  try {
    const body = await request.json();
    const { displayName, avatarUrl } = body as {
      displayName?: string;
      avatarUrl?: string;
    };

    // Input length validation
    if (displayName !== undefined && (typeof displayName !== "string" || displayName.length > 100)) {
      return NextResponse.json(
        { error: "Display name must be at most 100 characters" },
        { status: 400 },
      );
    }
    if (avatarUrl !== undefined && (typeof avatarUrl !== "string" || avatarUrl.length > 2048 || !avatarUrl.startsWith("https://"))) {
      return NextResponse.json(
        { error: "Avatar URL must be a valid HTTPS URL (max 2048 characters)" },
        { status: 400 },
      );
    }

    const data: { displayName?: string; avatarUrl?: string } = {};
    if (displayName !== undefined) data.displayName = displayName;
    if (avatarUrl !== undefined) data.avatarUrl = avatarUrl;

    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { error: "No fields to update" },
        { status: 400 },
      );
    }

    const updated = await prisma.user.update({
      where: { id: auth.userId },
      data,
    });

    return NextResponse.json({
      user: {
        id: updated.id,
        username: updated.username,
        displayName: updated.displayName,
        email: updated.email,
        emailVerified: updated.emailVerified,
        avatarUrl: updated.avatarUrl,
        role: updated.role,
        createdAt: updated.createdAt,
      },
    });
  } catch (err) {
    console.error("DB error updating user profile:", err);
    return NextResponse.json(
      { error: "Failed to update user profile" },
      { status: 500 },
    );
  }
}
