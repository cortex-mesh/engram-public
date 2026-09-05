import { NextResponse, type NextRequest } from "next/server";

import { authenticateRequest, isCurrentPlatformSuperadmin } from "@/lib/auth";
import { recordAuditEvent } from "@/lib/audit";
import { grantEnrollment, EnrollmentInputError, MAX_ENROLLMENT_LIFETIME_MS } from "@/lib/enrollment";
import { hasCrossOriginCookieWrite } from "@/lib/organizations";
import { prisma } from "@/lib/prisma";

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.userId === "internal" || hasCrossOriginCookieWrite(request) || !(await isCurrentPlatformSuperadmin(auth))) {
    return NextResponse.json({ error: "Only platform superadmins can grant Cite enrollment." }, { status: 403 });
  }
  let body: { subjectId?: unknown; expiresAt?: unknown };
  try {
    const parsed: unknown = await request.json();
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return NextResponse.json({ error: "JSON body must be an object." }, { status: 400 });
    body = parsed as { subjectId?: unknown; expiresAt?: unknown };
  } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const subjectId = typeof body.subjectId === "string" ? body.subjectId.trim() : "";
  const expiresAt = typeof body.expiresAt === "string" ? new Date(body.expiresAt) : new Date("");
  if (!subjectId || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() > Date.now() + MAX_ENROLLMENT_LIFETIME_MS) return NextResponse.json({ error: "subjectId and an expiresAt within 90 days are required." }, { status: 400 });
  const user = await prisma.user.findUnique({ where: { id: subjectId }, select: { id: true } });
  if (!user) return NextResponse.json({ error: "User not found." }, { status: 404 });
  try {
    const result = await grantEnrollment({ userId: subjectId, expiresAt });
    await recordAuditEvent({ action: "cite.enrollment.grant", outcome: "success", actorUserId: auth.userId, actorType: "admin", targetType: "enrollment", targetId: result.enrollment.id, metadata: { clientId: "axon-web", subjectId, version: result.enrollment.version, idempotent: result.idempotent }, request });
    return NextResponse.json({ enrollment: { id: result.enrollment.id, subjectId, clientId: "axon-web", status: result.enrollment.status, version: result.enrollment.version, expiresAt: result.enrollment.expiresAt.toISOString() }, idempotent: result.idempotent }, { status: result.idempotent ? 200 : 201 });
  } catch (cause) {
    if (cause instanceof EnrollmentInputError) return NextResponse.json({ error: cause.message }, { status: 400 });
    console.error("Cite enrollment grant failed:", cause);
    return NextResponse.json({ error: "Failed to grant Cite enrollment." }, { status: 500 });
  }
}
