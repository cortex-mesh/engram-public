import { NextResponse, type NextRequest } from "next/server";
import { authenticateRequest, isCurrentPlatformSuperadmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  hasCrossOriginCookieWrite,
  isOrgManager,
  isUniqueConstraintError,
  toOrganizationSummary,
  validateOrganizationInput,
} from "@/lib/organizations";

interface RouteContext {
  params: Promise<{ orgId: string }>;
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const auth = await authenticateRequest(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (auth.userId === "internal") {
    return NextResponse.json(
      { error: "Internal API key auth is not allowed for organization management." },
      { status: 403 },
    );
  }

  if (hasCrossOriginCookieWrite(request)) {
    return NextResponse.json(
      { error: "Cross-origin cookie-authenticated writes are not allowed." },
      { status: 403 },
    );
  }

  const { orgId } = await context.params;

  try {
    const membership = await prisma.orgMember.findFirst({
      where: {
        orgId,
        userId: auth.userId,
      },
      select: { role: true },
    });

    // Re-read the platform role from the DB, not the JWT claim (audit #9).
    const currentSuperadmin = await isCurrentPlatformSuperadmin(auth);

    if (!membership && !currentSuperadmin) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

    if (!currentSuperadmin && !isOrgManager(membership?.role)) {
      return NextResponse.json(
        {
          error:
            "Only organization admins and owners can update organization settings.",
        },
        { status: 403 },
      );
    }

    const body = (await request.json()) as { name?: unknown; slug?: unknown };
    const validated = validateOrganizationInput({
      name: body.name,
      slug: body.slug,
      partial: true,
    });

    if ("error" in validated) {
      return NextResponse.json({ error: validated.error }, { status: 400 });
    }

    const organization = await prisma.organization.update({
      where: { id: orgId },
      data: validated.data,
      include: {
        members: {
          where: { userId: auth.userId },
          select: { role: true, createdAt: true },
        },
        appEntitlements: {
          orderBy: { appKey: "asc" },
          select: { appKey: true, enabled: true, accessMode: true, updatedAt: true },
        },
        featureEntitlements: {
          orderBy: [{ appKey: "asc" }, { featureKey: "asc" }],
          select: { appKey: true, featureKey: true, enabled: true, updatedAt: true },
        },
        userAppOverrides: {
          where: { userId: auth.userId },
          orderBy: { appKey: "asc" },
          select: { appKey: true, enabled: true },
        },
        invites: {
          select: { createdAt: true, updatedAt: true, acceptedAt: true, revokedAt: true },
        },
        _count: {
          select: { members: true, invites: true },
        },
      }
    });

    return NextResponse.json({
      organization: toOrganizationSummary({
        ...organization,
        roleOverride: currentSuperadmin ? "OWNER" : membership?.role,
        isMemberOverride: currentSuperadmin ? false : undefined,
        platformRole: currentSuperadmin ? "SUPERADMIN" : null,
      }),
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return NextResponse.json(
        { error: "An organization with that name or slug already exists." },
        { status: 409 },
      );
    }

    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2025"
    ) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

    console.error("Failed to update organization:", error);
    return NextResponse.json(
      { error: "Failed to update organization" },
      { status: 500 },
    );
  }
}
