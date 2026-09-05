import { NextResponse, type NextRequest } from "next/server";

import { isAppKey, type AppKey } from "@/lib/authorization";
import { prisma } from "@/lib/prisma";
import { authorizeUserAppEntitlementRequest } from "@/lib/user-app-entitlements";
import { recordAuditEvent } from "@/lib/audit";

interface RouteContext {
  params: Promise<{ orgId: string; userId: string; appKey: string }>;
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { orgId, userId, appKey } = await context.params;

  if (!isAppKey(appKey)) {
    return NextResponse.json({ error: "Unknown app key." }, { status: 400 });
  }

  const guard = await authorizeUserAppEntitlementRequest(request, {
    orgId,
    mutation: true,
  });
  if (!guard.ok) return guard.response;

  // Intentionally NO ensureTargetIsOrgMember check here (unlike GET/PUT):
  // deleteMany is already scoped to this org and removing an override for a
  // non-member is harmless cleanup. Gating it would strand orphan rows left
  // by past data (security audit 2026-06-10, HG-1).
  const result = await prisma.userAppEntitlement.deleteMany({
    where: { userId, orgId, appKey: appKey as AppKey },
  });

  if (result.count === 0) {
    return NextResponse.json(
      { error: "No matching user app entitlement override exists." },
      { status: 404 },
    );
  }

  await recordAuditEvent({
    action: "user.app_entitlement.delete",
    outcome: "success",
    actorUserId: guard.auth.userId,
    actorType: guard.auth.superadmin ? "admin" : "user",
    targetType: "user",
    targetId: userId,
    orgId,
    metadata: { appKey },
    request,
  });

  return NextResponse.json({ success: true });
}
