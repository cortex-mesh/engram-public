import { NextResponse, type NextRequest } from "next/server";

import { requireAxonEnrollmentConsumer } from "@/lib/enrollment-auth";
import { EnrollmentCursorError, EnrollmentCursorExpiredError, getEnrollmentEvents, markDelivered } from "@/lib/enrollment";

export const dynamic = "force-dynamic";

function unavailable() {
  return NextResponse.json({ error: { code: "ENROLLMENT_STATE_UNAVAILABLE", message: "Enrollment state is temporarily unavailable.", retryable: true } }, { status: 503, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: NextRequest) {
  const consumer = requireAxonEnrollmentConsumer(request);
  if (!consumer.ok) return consumer.response;
  const after = request.nextUrl.searchParams.get("after_sequence");
  const limit = request.nextUrl.searchParams.get("limit") || "100";
  if (!/^(0|[1-9][0-9]*)$/.test(after || "") || !/^[1-9][0-9]*$/.test(limit)) {
    return NextResponse.json({ error: { code: "INVALID_CURSOR", message: "after_sequence and limit are invalid.", retryable: false } }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const afterSequence = Number(after);
  const pageSize = Number(limit);
  if (!Number.isSafeInteger(afterSequence) || !Number.isSafeInteger(pageSize) || pageSize > 100) {
    return NextResponse.json({ error: { code: "INVALID_CURSOR", message: "after_sequence and limit are invalid.", retryable: false } }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const page = await getEnrollmentEvents(afterSequence, pageSize);
    await markDelivered(page.events);
    return NextResponse.json({
      contract_version: 1,
      after_sequence: afterSequence,
      head_sequence: page.headSequence,
      events: page.events.map((event) => ({ sequence: event.sequence, event_id: event.id, event_hash: event.eventHash, signed_jws: event.signedJws })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    if (cause instanceof EnrollmentCursorExpiredError) {
      return NextResponse.json({ error: { code: "CURSOR_EXPIRED", message: "Cursor requires signed snapshot reconciliation.", retryable: true } }, { status: 409, headers: { "Cache-Control": "no-store" } });
    }
    if (cause instanceof EnrollmentCursorError) {
      return NextResponse.json({ error: { code: "INVALID_CURSOR", message: "Cursor is ahead of the signed enrollment head.", retryable: false } }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    console.error("Enrollment event delivery failed:", cause);
    return unavailable();
  }
}
