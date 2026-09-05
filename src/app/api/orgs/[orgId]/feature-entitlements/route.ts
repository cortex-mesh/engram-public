import { NextResponse, type NextRequest } from "next/server";

import { authenticateRequest, isCurrentPlatformSuperadmin } from "@/lib/auth";
import { isAppKey, isFeatureKey } from "@/lib/authorization";
import {
  hasCrossOriginCookieWrite,
  isForeignKeyConstraintError,
} from "@/lib/organizations";
import { prisma } from "@/lib/prisma";
import { recordAuditEvent } from "@/lib/audit";

interface RouteContext {
  params: Promise<{ orgId: string }>;
}

function forbiddenResponse() {
  return NextResponse.json(
    { error: "Only platform superadmins can manage organization feature entitlements." },
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
    select: { id: true },
  });

  if (!organization) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  const featureEntitlements = await prisma.orgAppFeatureEntitlement.findMany({
    where: { orgId },
    orderBy: [{ appKey: "asc" }, { featureKey: "asc" }],
    select: { appKey: true, featureKey: true, enabled: true },
  });

  return NextResponse.json({ featureEntitlements });
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

  const body = (await request.json()) as {
    appKey?: unknown;
    featureKey?: unknown;
    enabled?: unknown;
  };

  if (
    typeof body.appKey !== "string" ||
    !isAppKey(body.appKey) ||
    typeof body.featureKey !== "string" ||
    !isFeatureKey(body.appKey, body.featureKey) ||
    typeof body.enabled !== "boolean"
  ) {
    return NextResponse.json(
      {
        error:
          "Feature entitlements must include a valid appKey, featureKey, and boolean enabled flag.",
      },
      { status: 400 },
    );
  }

  const { orgId } = await context.params;
  const organization = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      appEntitlements: {
        where: { appKey: body.appKey },
        select: { appKey: true, enabled: true },
      },
    },
  });

  if (!organization) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  if (organization.appEntitlements.length === 0) {
    return NextResponse.json(
      {
        error:
          "An organization must be entitled to an app before feature entitlements can be managed.",
      },
      { status: 400 },
    );
  }

  if (!organization.appEntitlements[0]?.enabled) {
    return NextResponse.json(
      {
        error:
          "An organization must have an app enabled before feature entitlements can be managed.",
      },
      { status: 400 },
    );
  }

  try {
    await prisma.orgAppFeatureEntitlement.upsert({
      where: {
        orgId_appKey_featureKey: {
          orgId,
          appKey: body.appKey,
          featureKey: body.featureKey,
        },
      },
      create: {
        orgId,
        appKey: body.appKey,
        featureKey: body.featureKey,
        enabled: body.enabled,
      },
      update: {
        enabled: body.enabled,
      },
    });
  } catch (error) {
    if (isForeignKeyConstraintError(error)) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

    throw error;
  }

  await recordAuditEvent({
    action: "org.feature_entitlement.change",
    outcome: "success",
    actorUserId: auth.userId,
    actorType: "admin",
    targetType: "org",
    targetId: orgId,
    orgId,
    metadata: {
      appKey: body.appKey,
      featureKey: body.featureKey,
      enabled: body.enabled,
    },
    request,
  });

  const featureEntitlements = await prisma.orgAppFeatureEntitlement.findMany({
    where: { orgId },
    orderBy: [{ appKey: "asc" }, { featureKey: "asc" }],
    select: { appKey: true, featureKey: true, enabled: true },
  });

  return NextResponse.json({ featureEntitlements });
}
