import { NextResponse, type NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { recordAuditEvent } from "@/lib/audit";
import { authorizeOrgAdminRequest } from "@/lib/org-admin-auth";

interface RouteContext {
  params: Promise<{ orgId: string; inviteId: string }>;
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { orgId, inviteId } = await context.params;
  const guard = await authorizeOrgAdminRequest(request, { orgId, mutation: true });
  if (!guard.ok) return guard.response;

  const invite = await prisma.orgInvite.findFirst({
    where: { id: inviteId, orgId },
    select: { id: true, email: true, role: true, acceptedAt: true, revokedAt: true },
  });
  if (!invite) {
    return NextResponse.json({ error: "Invite not found." }, { status: 404 });
  }

  if (invite.acceptedAt) {
    return NextResponse.json({ error: "Cannot revoke an already-accepted invite." }, { status: 400 });
  }
  if (invite.revokedAt) {
    return NextResponse.json({ error: "Invite has already been revoked." }, { status: 400 });
  }

  await prisma.orgInvite.update({
    where: { id: inviteId, orgId },
    data: { revokedAt: new Date() },
  });

  await recordAuditEvent({
    action: "org.invite.revoke",
    outcome: "success",
    actorUserId: guard.auth.userId,
    actorType: guard.auth.superadmin ? "admin" : "org_admin",
    targetType: "invite",
    targetId: inviteId,
    orgId,
    metadata: { email: invite.email, role: invite.role },
    request,
  });

  return NextResponse.json({ success: true });
}
