// GET /api/internal/orgs/{orgId}/owner — Engram ADR-022.
// Returns all OWNER members for the org (amended 2026-06-16, ADR-022 §5.1).
// Response includes both `owners` (new array, accept any) and `owner` (first entry,
// backward compat with older cortex-api clients).
// Guarded by requireInternalService — no user JWT or cookie admitted.

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireInternalService } from "@/lib/internal-auth";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const auth = requireInternalService(request);
  if (!auth.ok) return auth.response;

  const { orgId } = await params;

  const members = await prisma.orgMember.findMany({
    where: { orgId, role: "OWNER" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      user: {
        select: { id: true, email: true, displayName: true },
      },
    },
  });

  if (members.length === 0) {
    return new NextResponse(null, {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const owners = members.map((m) => ({
    engramUserId: m.user.id,
    email: m.user.email,
    displayName: m.user.displayName,
  }));

  return NextResponse.json(
    {
      orgId,
      owner: owners[0],
      owners,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
