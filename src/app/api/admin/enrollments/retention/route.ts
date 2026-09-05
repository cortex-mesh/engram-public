import { NextResponse, type NextRequest } from "next/server";

import { authenticateRequest, isCurrentPlatformSuperadmin } from "@/lib/auth";
import { recordAuditEvent } from "@/lib/audit";
import {
  EnrollmentInputError,
  retireEnrollmentEventsBefore,
} from "@/lib/enrollment";
import { hasCrossOriginCookieWrite } from "@/lib/organizations";

/**
 * Explicit, audited rotation operation. Operators call this only after the
 * retired verification key has been removed and a replacement snapshot is
 * available; the service refuses to remove the current immutable head.
 */
export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!auth)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (
    auth.userId === "internal" ||
    hasCrossOriginCookieWrite(request) ||
    !(await isCurrentPlatformSuperadmin(auth))
  ) {
    return NextResponse.json(
      {
        error:
          "Only platform superadmins can advance Cite enrollment retention.",
      },
      { status: 403 },
    );
  }
  let firstRetainedSequence: unknown;
  try {
    const body: unknown = await request.json();
    if (!body || Array.isArray(body) || typeof body !== "object")
      return NextResponse.json(
        { error: "JSON body must be an object." },
        { status: 400 },
      );
    firstRetainedSequence = (body as Record<string, unknown>)
      .firstRetainedSequence;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (
    typeof firstRetainedSequence !== "number" ||
    !Number.isSafeInteger(firstRetainedSequence) ||
    firstRetainedSequence < 1
  )
    return NextResponse.json(
      { error: "firstRetainedSequence must be a positive integer." },
      { status: 400 },
    );
  try {
    const stream = await retireEnrollmentEventsBefore(firstRetainedSequence);
    await recordAuditEvent({
      action: "cite.enrollment.retention",
      outcome: "success",
      actorUserId: auth.userId,
      actorType: "admin",
      targetType: "enrollment_stream",
      targetId: "axon-web",
      metadata: {
        clientId: "axon-web",
        retainedFrom: stream.retainedFrom,
        headSequence: stream.headSequence,
      },
      request,
    });
    return NextResponse.json({
      clientId: "axon-web",
      retainedFrom: stream.retainedFrom,
      headSequence: stream.headSequence,
    });
  } catch (cause) {
    if (cause instanceof EnrollmentInputError)
      return NextResponse.json({ error: cause.message }, { status: 400 });
    console.error("Cite enrollment retention failed:", cause);
    return NextResponse.json(
      { error: "Failed to advance Cite enrollment retention." },
      { status: 500 },
    );
  }
}
