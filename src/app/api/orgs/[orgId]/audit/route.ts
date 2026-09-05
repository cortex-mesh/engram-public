import { NextResponse, type NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { authorizeOrgAdminRequest } from "@/lib/org-admin-auth";

interface RouteContext {
  params: Promise<{ orgId: string }>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(request: NextRequest, context: RouteContext) {
  const { orgId } = await context.params;
  const guard = await authorizeOrgAdminRequest(request, { orgId, mutation: false });
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const rawLimit = parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = isNaN(rawLimit) || rawLimit < 1 ? DEFAULT_LIMIT : Math.min(rawLimit, MAX_LIMIT);
  const cursor = url.searchParams.get("cursor") ?? undefined;

  const rows = await prisma.auditLog.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      createdAt: true,
      action: true,
      outcome: true,
      actorUserId: true,
      actorType: true,
      targetType: true,
      targetId: true,
      metadata: true,
    },
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  return NextResponse.json({
    events: items.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      action: r.action,
      outcome: r.outcome,
      actorUserId: r.actorUserId,
      actorType: r.actorType,
      targetType: r.targetType,
      targetId: r.targetId,
      metadata: r.metadata,
    })),
    nextCursor: hasMore ? items[items.length - 1]?.id : null,
  });
}
