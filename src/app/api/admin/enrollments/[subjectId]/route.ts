import { NextResponse, type NextRequest } from "next/server";

import { authenticateRequest, isCurrentPlatformSuperadmin } from "@/lib/auth";
import { recordAuditEvent } from "@/lib/audit";
import { EnrollmentNotFoundError, revokeEnrollment } from "@/lib/enrollment";
import { hasCrossOriginCookieWrite } from "@/lib/organizations";

interface RouteContext { params: Promise<{ subjectId: string }> }

export async function DELETE(request: NextRequest, context: RouteContext) {
  const auth = await authenticateRequest(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.userId === "internal" || hasCrossOriginCookieWrite(request) || !(await isCurrentPlatformSuperadmin(auth))) {
    return NextResponse.json({ error: "Only platform superadmins can revoke Cite enrollment." }, { status: 403 });
  }
  const { subjectId } = await context.params;
  let reason: string | undefined;
  const rawBody = await request.text();
  if (rawBody.trim()) {
    let body: { reason?: unknown };
    try {
      body = JSON.parse(rawBody) as { reason?: unknown };
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    if (!body || Array.isArray(body) || typeof body !== "object") {
      return NextResponse.json({ error: "JSON body must be an object." }, { status: 400 });
    }
    if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 256)) return NextResponse.json({ error: "reason must be at most 256 characters." }, { status: 400 });
    reason = body.reason?.trim() || undefined;
  }
  try {
    const result = await revokeEnrollment({ userId: subjectId, reason });
    await recordAuditEvent({ action: "cite.enrollment.revoke", outcome: "success", actorUserId: auth.userId, actorType: "admin", targetType: "enrollment", targetId: result.enrollment.id, metadata: { clientId: "axon-web", subjectId, version: result.enrollment.version, idempotent: result.idempotent }, request });
    return NextResponse.json({ enrollment: { id: result.enrollment.id, subjectId, clientId: "axon-web", status: result.enrollment.status, version: result.enrollment.version, revokedAt: result.enrollment.revokedAt?.toISOString() ?? null }, idempotent: result.idempotent });
  } catch (cause) {
    if (cause instanceof EnrollmentNotFoundError) return NextResponse.json({ error: "Enrollment not found." }, { status: 404 });
    console.error("Cite enrollment revocation failed:", cause);
    return NextResponse.json({ error: "Failed to revoke Cite enrollment." }, { status: 500 });
  }
}
