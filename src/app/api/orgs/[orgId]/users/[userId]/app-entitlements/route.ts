import { NextResponse, type NextRequest } from "next/server";

import { isAppKey } from "@/lib/authorization";
import { isForeignKeyConstraintError } from "@/lib/organizations";
import { prisma } from "@/lib/prisma";
import { recordAuditEvent } from "@/lib/audit";
import {
  authorizeUserAppEntitlementRequest,
  ensureOrgHasAppEntitled,
  ensureTargetIsOrgMember,
} from "@/lib/user-app-entitlements";

interface RouteContext {
  params: Promise<{ orgId: string; userId: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { orgId, userId } = await context.params;
  const guard = await authorizeUserAppEntitlementRequest(request, {
    orgId,
    mutation: false,
  });
  if (!guard.ok) return guard.response;

  const notMember = await ensureTargetIsOrgMember({ orgId, userId });
  if (notMember) return notMember;

  const overrides = await prisma.userAppEntitlement.findMany({
    where: { orgId, userId },
    orderBy: { appKey: "asc" },
    select: {
      appKey: true,
      enabled: true,
      createdAt: true,
      updatedAt: true,
      createdByUserId: true,
      updatedByUserId: true,
    },
  });

  return NextResponse.json({
    userAppEntitlements: overrides.map((row) => ({
      appKey: row.appKey,
      enabled: row.enabled,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      createdByUserId: row.createdByUserId,
      updatedByUserId: row.updatedByUserId,
    })),
  });
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const { orgId, userId } = await context.params;
  const guard = await authorizeUserAppEntitlementRequest(request, {
    orgId,
    mutation: true,
  });
  if (!guard.ok) return guard.response;

  const body = (await request.json()) as { appKey?: unknown; enabled?: unknown };
  if (
    typeof body.appKey !== "string" ||
    !isAppKey(body.appKey) ||
    typeof body.enabled !== "boolean"
  ) {
    return NextResponse.json(
      {
        error:
          "User app entitlements must include a valid appKey and boolean enabled flag.",
      },
      { status: 400 },
    );
  }

  // Membership check first so a non-member target returns 404 uniformly,
  // regardless of whether the app is org-entitled — otherwise the 400-vs-404
  // split would let an owner probe org membership per app.
  const notMember = await ensureTargetIsOrgMember({ orgId, userId });
  if (notMember) return notMember;

  const orgGate = await ensureOrgHasAppEntitled({
    orgId,
    appKey: body.appKey,
    superadmin: guard.auth.superadmin,
  });
  if (orgGate) return orgGate;

  try {
    const existing = await prisma.userAppEntitlement.findUnique({
      where: {
        userId_orgId_appKey: {
          userId,
          orgId,
          appKey: body.appKey,
        },
      },
      select: { id: true, createdByUserId: true },
    });

    const row = await prisma.userAppEntitlement.upsert({
      where: {
        userId_orgId_appKey: {
          userId,
          orgId,
          appKey: body.appKey,
        },
      },
      create: {
        userId,
        orgId,
        appKey: body.appKey,
        enabled: body.enabled,
        createdByUserId: guard.auth.userId,
        updatedByUserId: guard.auth.userId,
      },
      update: {
        enabled: body.enabled,
        updatedByUserId: guard.auth.userId,
        // preserve createdByUserId on existing rows
        ...(existing?.createdByUserId
          ? {}
          : { createdByUserId: guard.auth.userId }),
      },
      select: {
        appKey: true,
        enabled: true,
        createdAt: true,
        updatedAt: true,
        createdByUserId: true,
        updatedByUserId: true,
      },
    });

    await recordAuditEvent({
      action: "user.app_entitlement.set",
      outcome: "success",
      actorUserId: guard.auth.userId,
      actorType: guard.auth.superadmin ? "admin" : "user",
      targetType: "user",
      targetId: userId,
      orgId,
      metadata: { appKey: body.appKey, enabled: body.enabled },
      request,
    });

    return NextResponse.json({
      userAppEntitlement: {
        appKey: row.appKey,
        enabled: row.enabled,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        createdByUserId: row.createdByUserId,
        updatedByUserId: row.updatedByUserId,
      },
    });
  } catch (error) {
    if (isForeignKeyConstraintError(error)) {
      return NextResponse.json(
        { error: "Organization or user not found." },
        { status: 404 },
      );
    }
    throw error;
  }
}
