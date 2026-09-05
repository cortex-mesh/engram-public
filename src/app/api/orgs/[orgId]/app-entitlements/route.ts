import { NextResponse, type NextRequest } from "next/server";

import { authenticateRequest, isCurrentPlatformSuperadmin } from "@/lib/auth";
import { isAppKey } from "@/lib/authorization";
import {
  hasCrossOriginCookieWrite,
  isForeignKeyConstraintError,
  toOrganizationSummary,
} from "@/lib/organizations";
import { prisma } from "@/lib/prisma";
import { recordAuditEvent } from "@/lib/audit";

interface RouteContext {
  params: Promise<{ orgId: string }>;
}

function forbiddenResponse() {
  return NextResponse.json(
    { error: "Only platform superadmins can manage organization app entitlements." },
    { status: 403 },
  );
}

export async function GET(request: NextRequest, context: RouteContext) {
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

  if (!(await isCurrentPlatformSuperadmin(auth))) {
    return forbiddenResponse();
  }

  const { orgId } = await context.params;
  const organization = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      appEntitlements: {
        orderBy: { appKey: "asc" },
        select: { appKey: true, enabled: true },
      },
    },
  });

  if (!organization) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  return NextResponse.json({ appEntitlements: organization.appEntitlements });
}

export async function PUT(request: NextRequest, context: RouteContext) {
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

  if (!(await isCurrentPlatformSuperadmin(auth))) {
    return forbiddenResponse();
  }

  const body = (await request.json()) as { appKey?: unknown; enabled?: unknown };
  if (typeof body.appKey !== "string" || !isAppKey(body.appKey) || typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "App entitlements must include a valid appKey and boolean enabled flag." },
      { status: 400 },
    );
  }

  const { orgId } = await context.params;

  const organization = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true },
  });

  if (!organization) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  let entitlement;

  try {
    entitlement = await prisma.orgAppEntitlement.upsert({
      where: {
        orgId_appKey: {
          orgId,
          appKey: body.appKey,
        },
      },
      create: {
        orgId,
        appKey: body.appKey,
        enabled: body.enabled,
      },
      update: {
        enabled: body.enabled,
      },
      include: {
        org: {
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
              select: { createdAt: true, updatedAt: true, acceptedAt: true, revokedAt: true },
            },
            _count: {
              select: { members: true, invites: true },
            },
          }
        },
      },
    });
  } catch (error) {
    if (isForeignKeyConstraintError(error)) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

    throw error;
  }

  await recordAuditEvent({
    action: "org.app_entitlement.change",
    outcome: "success",
    actorUserId: auth.userId,
    actorType: "admin",
    targetType: "org",
    targetId: orgId,
    orgId,
    metadata: { appKey: body.appKey, enabled: body.enabled },
    request,
  });

  return NextResponse.json({
    organization: toOrganizationSummary({
      ...entitlement.org,
      roleOverride: auth.role,
      platformRole: "SUPERADMIN",
    }),
  });
}
