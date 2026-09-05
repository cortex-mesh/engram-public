import { NextResponse, type NextRequest } from "next/server";

import { requireAxonEnrollmentConsumer } from "@/lib/enrollment-auth";
import { currentSnapshot, markSnapshotHeadDelivered } from "@/lib/enrollment";

export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const consumer = requireAxonEnrollmentConsumer(request);
  if (!consumer.ok) return consumer.response;
  try {
    const snapshot = await currentSnapshot();
    await markSnapshotHeadDelivered(
      snapshot.headSequence,
      snapshot.headEventId,
      snapshot.headEventHash,
      snapshot.signedJws,
    );
    return NextResponse.json(
      {
        contract_version: 1,
        head_sequence: snapshot.headSequence,
        head_event_id: snapshot.headEventId,
        head_event_hash: snapshot.headEventHash,
        signed_jws: snapshot.signedJws,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (cause) {
    // The response stays a bare 503 — contract v1 is fixed and the consumer's
    // rule is to deny on it (ADR-034 §4). The LOG must still distinguish the
    // causes, because they demand opposite operator responses: an unconfigured
    // environment is an expected steady state (§8.3), while write contention
    // means the authority is denying users under its own load. Collapsing both
    // into one opaque line is why contention first surfaced as a flaky test.
    const code = (cause as { code?: string })?.code;
    const contention =
      code === "P2034" ||
      code === "P2002" ||
      String((cause as Error)?.message).includes("TransactionWriteConflict");
    console.error(
      contention
        ? "Enrollment snapshot failed: write contention (denying a consumer under load):"
        : "Enrollment snapshot generation failed:",
      cause,
    );
    return NextResponse.json(
      {
        error: {
          code: "ENROLLMENT_STATE_UNAVAILABLE",
          message: "Enrollment state is temporarily unavailable.",
          retryable: true,
        },
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
