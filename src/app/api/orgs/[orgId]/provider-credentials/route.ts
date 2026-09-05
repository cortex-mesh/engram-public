import { NextResponse, type NextRequest } from "next/server";

import { authorizeOrgAdminRequest } from "@/lib/org-admin-auth";
import { prisma } from "@/lib/prisma";

interface RouteContext {
  params: Promise<{ orgId: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { orgId } = await context.params;
  const guard = await authorizeOrgAdminRequest(request, { orgId, mutation: false });
  if (!guard.ok) return guard.response;

  const credentials = await prisma.orgProviderCredential.findMany({
    where: { orgId },
    orderBy: { provider: "asc" },
    select: {
      provider: true,
      status: true,
      last4: true,
      credentialKind: true,
      rotatedAt: true,
      updatedAt: true,
    },
  });

  return NextResponse.json({ credentials });
}
