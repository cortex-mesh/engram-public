import { NextResponse, type NextRequest } from "next/server";

import { isAppKey, type AppKey } from "@/lib/authorization";
import { prisma } from "@/lib/prisma";
import {
  authorizeUserAppEntitlementRequest,
  ensureOrgHasAppEntitled,
} from "@/lib/user-app-entitlements";

interface RouteContext {
  params: Promise<{ orgId: string; appKey: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { orgId, appKey } = await context.params;

  if (!isAppKey(appKey)) {
    return NextResponse.json({ error: "Unknown app key." }, { status: 400 });
  }

  const guard = await authorizeUserAppEntitlementRequest(request, {
    orgId,
    mutation: false,
  });
  if (!guard.ok) return guard.response;

  // OWNER/ADMIN may only see overrides for apps the org actually has
  // enabled (superadmin bypasses), matching the write path's gate.
  const orgGate = await ensureOrgHasAppEntitled({
    orgId,
    appKey: appKey as AppKey,
    superadmin: guard.auth.superadmin,
  });
  if (orgGate) return orgGate;

  const overrides = await prisma.userAppEntitlement.findMany({
    // Filter through OrgMember so identity fields from stale/orphan rows
    // (users no longer — or never — in this org) are never returned.
    where: {
      orgId,
      appKey: appKey as AppKey,
      user: { orgMembers: { some: { orgId } } },
    },
    orderBy: { updatedAt: "desc" },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          username: true,
          displayName: true,
        },
      },
    },
  });

  return NextResponse.json({
    userAppEntitlements: overrides.map((row) => ({
      user: {
        id: row.user.id,
        email: row.user.email,
        username: row.user.username,
        displayName: row.user.displayName,
      },
      appKey: row.appKey,
      enabled: row.enabled,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      createdByUserId: row.createdByUserId,
      updatedByUserId: row.updatedByUserId,
    })),
  });
}
