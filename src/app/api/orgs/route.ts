import { NextResponse, type NextRequest } from "next/server";
import { authenticateRequest, isCurrentPlatformSuperadmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  hasCrossOriginCookieWrite,
  isUniqueConstraintError,
  toOrganizationSummary,
  validateOrganizationInput,
} from "@/lib/organizations";

export async function GET(request: NextRequest) {
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

  try {
    // Re-read the platform role from the DB, not the JWT claim (audit #9) —
    // appAccess gates admission to privacy-sensitive apps (ADR-030). Only
    // ever pass the "SUPERADMIN" sentinel once freshly confirmed; a stale
    // JWT claim must never grant it.
    const currentSuperadmin = await isCurrentPlatformSuperadmin(auth);
    const platformRole = currentSuperadmin ? "SUPERADMIN" : null;

    const memberships = await prisma.orgMember.findMany({
      where: { userId: auth.userId },
      orderBy: { createdAt: "asc" },
      include: {
        org: {
          include: {
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
          },
        },
      },
    });

    return NextResponse.json({
      organizations: memberships.map((membership) =>
        toOrganizationSummary({
          ...membership.org,
          members: [{ role: membership.role, createdAt: membership.createdAt }],
          platformRole,
        }),
      ),
    });
  } catch (error) {
    console.error("Failed to fetch organizations:", error);
    return NextResponse.json(
      { error: "Failed to fetch organizations" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
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

  const currentSuperadmin = await isCurrentPlatformSuperadmin(auth);
  if (!currentSuperadmin) {
    return NextResponse.json(
      { error: "Only platform superadmins can create organizations." },
      { status: 403 },
    );
  }

  try {
    const body = (await request.json()) as { name?: unknown; slug?: unknown };
    const validated = validateOrganizationInput({
      name: body.name,
      slug: body.slug,
    });

    if ("error" in validated) {
      return NextResponse.json({ error: validated.error }, { status: 400 });
    }

    const existing = await prisma.organization.findFirst({
      where: {
        OR: [{ name: validated.data.name }, { slug: validated.data.slug }],
      },
      select: { id: true },
    });

    if (existing) {
      return NextResponse.json(
        { error: "An organization with that name or slug already exists." },
        { status: 409 },
      );
    }

    const organization = await prisma.organization.create({
      data: {
        name: validated.data.name!,
        slug: validated.data.slug!,
      },
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
        invites: {
          where: { acceptedAt: null, revokedAt: null },
          select: { createdAt: true, acceptedAt: true, revokedAt: true },
        },
        _count: {
          select: { members: true, invites: true },
        },
      },
    });

    return NextResponse.json(
      {
        // currentSuperadmin is always true here — the handler already 403s
        // above for anyone else — so this is never the non-superadmin case.
        organization: toOrganizationSummary({
          ...organization,
          platformRole: "SUPERADMIN",
        }),
      },
      { status: 201 },
    );
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return NextResponse.json(
        { error: "An organization with that name or slug already exists." },
        { status: 409 },
      );
    }

    console.error("Failed to create organization:", error);
    return NextResponse.json(
      { error: "Failed to create organization" },
      { status: 500 },
    );
  }
}
