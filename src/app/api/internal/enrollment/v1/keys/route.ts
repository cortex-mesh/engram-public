import { NextResponse, type NextRequest } from "next/server";

import { requireAxonEnrollmentConsumer } from "@/lib/enrollment-auth";
import { getEnrollmentSigningKeys } from "@/lib/enrollment-crypto";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const consumer = requireAxonEnrollmentConsumer(request);
  if (!consumer.ok) return consumer.response;
  try {
    return NextResponse.json(await getEnrollmentSigningKeys(), { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    console.error("Enrollment signing key publication failed:", cause);
    return NextResponse.json({ error: { code: "ENROLLMENT_STATE_UNAVAILABLE", message: "Enrollment state is temporarily unavailable.", retryable: true } }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
