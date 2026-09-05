import { NextResponse, type NextRequest } from "next/server";

import { isAppAccessMode } from "@/lib/app-access";
import { isAppKey, type AppKey } from "@/lib/authorization";
import { prisma } from "@/lib/prisma";
import { recordAuditEvent } from "@/lib/audit";
import {
  authorizeUserAppEntitlementRequest,
  ensureOrgHasAppEntitled,
} from "@/lib/user-app-entitlements";

interface RouteContext {
  params: Promise<{ orgId: string; appKey: string }>;
}

function isRecordNotFound(error: unknown): boolean {
  return (error as { code?: string })?.code === "P2025";
}

/**
 * ADR-030 D5 — set an app's access mode (ALL_MEMBERS <-> RESTRICTED) within
 * an org. Reuses the same dual authz as the per-user override endpoints
 * (platform SUPERADMIN, or org OWNER/ADMIN for an app their org already has
 * enabled) — no new authz model. Distinct from the superadmin-only
 * PUT /api/orgs/[orgId]/app-entitlements, which grants/revokes the app for
 * the org in the first place; this only changes how an already-granted app
 * is exposed within the org.
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  const { orgId, appKey } = await context.params;

  if (!isAppKey(appKey)) {
    return NextResponse.json({ error: "Unknown app key." }, { status: 400 });
  }

  const guard = await authorizeUserAppEntitlementRequest(request, {
    orgId,
    mutation: true,
  });
  if (!guard.ok) return guard.response;

  const body = (await request.json()) as { accessMode?: unknown };
  if (typeof body.accessMode !== "string" || !isAppAccessMode(body.accessMode)) {
    return NextResponse.json(
      { error: "App access mode must be one of: ALL_MEMBERS, RESTRICTED." },
      { status: 400 },
    );
  }

  const orgGate = await ensureOrgHasAppEntitled({
    orgId,
    appKey: appKey as AppKey,
    superadmin: guard.auth.superadmin,
    errorMessage:
      "Organization owners and admins can only set the access mode for apps the org has enabled.",
  });
  if (orgGate) return orgGate;

  let entitlement;
  try {
    entitlement = await prisma.orgAppEntitlement.update({
      where: { orgId_appKey: { orgId, appKey: appKey as AppKey } },
      data: { accessMode: body.accessMode },
      select: { appKey: true, enabled: true, accessMode: true, updatedAt: true },
    });
  } catch (error) {
    if (isRecordNotFound(error)) {
      return NextResponse.json(
        { error: "Organization does not have this app entitled." },
        { status: 404 },
      );
    }
    throw error;
  }

  await recordAuditEvent({
    action: "org.app_entitlement.access_mode_change",
    outcome: "success",
    actorUserId: guard.auth.userId,
    actorType: guard.auth.superadmin ? "admin" : "org_admin",
    targetType: "org",
    targetId: orgId,
    orgId,
    metadata: { appKey, accessMode: body.accessMode },
    request,
  });

  return NextResponse.json({
    appEntitlement: {
      appKey: entitlement.appKey,
      enabled: entitlement.enabled,
      accessMode: entitlement.accessMode,
      updatedAt: entitlement.updatedAt.toISOString(),
    },
  });
}
