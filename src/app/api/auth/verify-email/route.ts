import { NextRequest, NextResponse } from "next/server";

import { consumeMagicLink } from "@/lib/db/magic-links";
import {
  ACCESS_COOKIE_NAME,
  ACCESS_COOKIE_OPTIONS,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_OPTIONS,
  generateTokenPair,
} from "@/lib/jwt";
import { sha256 } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import { getDefaultPostLoginTarget } from "@/lib/apps";
import { recordAuditEvent } from "@/lib/audit";
import { getPublicOrigin } from "@/lib/public-origin";

export async function GET(request: NextRequest) {
  const baseUrl = getPublicOrigin(request);
  const token = request.nextUrl.searchParams.get("token");
  if (!token) {
    return NextResponse.redirect(new URL("/login?error=missing_token", baseUrl));
  }

  const { valid, userId, reason } = await consumeMagicLink(token, "verify_email");
  if (!valid || !userId) {
    const errorParam =
      reason === "expired"
        ? "link_expired"
        : reason === "already_used"
          ? "link_used"
          : "invalid_link";
    return NextResponse.redirect(new URL(`/login?error=${errorParam}`, baseUrl));
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: { emailVerified: true },
    select: {
      id: true,
      displayName: true,
      role: true,
      lastOrgId: true,
      orgMembers: {
        orderBy: { createdAt: "asc" },
        include: { org: { select: { id: true, slug: true } } },
      },
    },
  });

  const { accessToken, refreshToken } = await generateTokenPair({
    id: user.id,
    displayName: user.displayName,
    role: user.role,
  });

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: sha256(refreshToken),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });

  await recordAuditEvent({
    action: "magic_link.consumed",
    outcome: "success",
    actorUserId: user.id,
    targetType: "user",
    targetId: user.id,
    metadata: { purpose: "verify_email" },
    request,
  });

  const destination = getDefaultPostLoginTarget({
    role: user.role,
    orgMemberships: user.orgMembers,
    lastOrgId: user.lastOrgId,
  });
  const response = NextResponse.redirect(new URL(destination, baseUrl));
  response.cookies.set(ACCESS_COOKIE_NAME, accessToken, ACCESS_COOKIE_OPTIONS);
  response.cookies.set(REFRESH_COOKIE_NAME, refreshToken, REFRESH_COOKIE_OPTIONS);
  return response;
}
