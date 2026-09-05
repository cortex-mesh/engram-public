import { NextResponse, type NextRequest } from "next/server";

import { requireAxonEnrollmentConsumer } from "@/lib/enrollment-auth";
import { EnrollmentAcknowledgementError, acknowledgeEnrollmentHead } from "@/lib/enrollment";

export const dynamic = "force-dynamic";

function invalid() {
  return NextResponse.json({ error: { code: "ACKNOWLEDGEMENT_INVALID", message: "Acknowledgement body is invalid.", retryable: false } }, { status: 400, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const consumer = requireAxonEnrollmentConsumer(request);
  if (!consumer.ok) return consumer.response;
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return invalid();
    body = parsed as Record<string, unknown>;
  } catch { return invalid(); }
  const headSequence = body.head_sequence;
  const headEventId = body.head_event_id;
  const headEventHash = body.head_event_hash;
  const headJwsHash = body.head_jws_hash;
  if (body.contract_version !== 1 || !Number.isSafeInteger(headSequence) || (headSequence as number) < 0 || !["string", "object"].includes(typeof headEventId) || !["string", "object"].includes(typeof headEventHash) || typeof headJwsHash !== "string") return invalid();
  if ((headEventId !== null && typeof headEventId !== "string") || (headEventHash !== null && typeof headEventHash !== "string") || !/^[A-Za-z0-9_-]{43}$/.test(headJwsHash)) return invalid();
  try {
    const acknowledgement = await acknowledgeEnrollmentHead({ headSequence: headSequence as number, headEventId: headEventId as string | null, headEventHash: headEventHash as string | null, headJwsHash });
    return NextResponse.json({ contract_version: 1, status: "acknowledged", consumer_id: "axon", client_id: "axon-web", head_sequence: acknowledgement.headSequence, head_event_id: acknowledgement.headEventId, head_event_hash: acknowledgement.headEventHash, acknowledged_at: acknowledgement.acknowledgedAt.toISOString() }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    if (cause instanceof EnrollmentAcknowledgementError) {
      return NextResponse.json({ error: { code: "ACKNOWLEDGEMENT_CONFLICT", message: cause.message, retryable: false } }, { status: 409, headers: { "Cache-Control": "no-store" } });
    }
    console.error("Enrollment acknowledgement failed:", cause);
    return NextResponse.json({ error: { code: "ENROLLMENT_STATE_UNAVAILABLE", message: "Enrollment state is temporarily unavailable.", retryable: true } }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
