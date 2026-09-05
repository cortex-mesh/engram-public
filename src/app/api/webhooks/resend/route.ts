import { NextRequest, NextResponse } from "next/server";

import { getResend } from "@/lib/email";
import { suppressEmailAddress } from "@/lib/email-suppression";

type ResendWebhookEvent = {
  type?: unknown;
  data?: {
    email_id?: unknown;
    id?: unknown;
    to?: unknown;
    [key: string]: unknown;
  };
};

const SUPPRESSING_EVENTS = new Map<string, "bounced" | "complained">([
  ["email.bounced", "bounced"],
  ["email.complained", "complained"],
]);

function recipientsFromEvent(event: ResendWebhookEvent): string[] {
  const to = event.data?.to;
  if (typeof to === "string") return [to];
  if (Array.isArray(to)) {
    return to.filter((value): value is string => typeof value === "string");
  }
  return [];
}

export async function POST(request: NextRequest) {
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("Resend webhook secret is not configured.");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  }

  const payload = await request.text();
  let event: ResendWebhookEvent;
  try {
    event = getResend().webhooks.verify({
      payload,
      headers: {
        id: request.headers.get("svix-id") ?? "",
        timestamp: request.headers.get("svix-timestamp") ?? "",
        signature: request.headers.get("svix-signature") ?? "",
      },
      webhookSecret,
    }) as unknown as ResendWebhookEvent;
  } catch (error) {
    console.warn("Invalid Resend webhook signature:", error);
    return NextResponse.json({ error: "Invalid webhook" }, { status: 400 });
  }

  const type = typeof event.type === "string" ? event.type : "";
  const reason = SUPPRESSING_EVENTS.get(type);
  if (!reason) {
    return NextResponse.json({ ok: true, suppressed: 0 });
  }

  const recipients = recipientsFromEvent(event);
  const providerMessageId =
    typeof event.data?.email_id === "string"
      ? event.data.email_id
      : typeof event.data?.id === "string"
        ? event.data.id
        : null;

  for (const email of recipients) {
    await suppressEmailAddress({
      email,
      reason,
      source: "resend_webhook",
      eventType: type,
      providerMessageId,
      rawEvent: event,
    });
  }

  console.warn("Resend webhook updated email suppressions:", {
    type,
    count: recipients.length,
    providerMessageId,
  });
  return NextResponse.json({ ok: true, suppressed: recipients.length });
}
