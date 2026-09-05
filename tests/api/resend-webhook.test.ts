import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockVerify, mockSuppressEmailAddress } = vi.hoisted(() => ({
  mockVerify: vi.fn(),
  mockSuppressEmailAddress: vi.fn(),
}));

vi.mock("@/lib/email", () => ({
  getResend: () => ({
    webhooks: {
      verify: mockVerify,
    },
  }),
}));
vi.mock("@/lib/email-suppression", () => ({
  suppressEmailAddress: mockSuppressEmailAddress,
}));

import { POST } from "@/app/api/webhooks/resend/route";

function webhookRequest(body: object, headers?: Record<string, string>) {
  return new NextRequest("https://login.ctxhost.com/api/webhooks/resend", {
    method: "POST",
    headers: {
      "svix-id": "msg_1",
      "svix-timestamp": "123",
      "svix-signature": "sig",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/webhooks/resend", () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.RESEND_WEBHOOK_SECRET = "whsec_test";
    vi.clearAllMocks();
  });

  it("rejects unsigned webhooks before mutating suppression state", async () => {
    mockVerify.mockImplementation(() => {
      throw new Error("bad signature");
    });
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await POST(webhookRequest({ type: "email.bounced" }));

    expect(res.status).toBe(400);
    expect(mockSuppressEmailAddress).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledWith("Invalid Resend webhook signature:", expect.any(Error));
    consoleWarn.mockRestore();
  });

  it("fails closed when the webhook secret is not configured", async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(webhookRequest({ type: "email.bounced" }));

    expect(res.status).toBe(503);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockSuppressEmailAddress).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith("Resend webhook secret is not configured.");
    consoleError.mockRestore();
  });

  it("suppresses bounced recipients from a verified Resend event", async () => {
    const event = {
      type: "email.bounced",
      data: {
        email_id: "email-1",
        to: ["Bounce@Example.com"],
      },
    };
    mockVerify.mockReturnValue(event);
    mockSuppressEmailAddress.mockResolvedValue(undefined);

    const res = await POST(webhookRequest(event));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, suppressed: 1 });
    expect(mockVerify).toHaveBeenCalledWith({
      payload: JSON.stringify(event),
      headers: { id: "msg_1", timestamp: "123", signature: "sig" },
      webhookSecret: "whsec_test",
    });
    expect(mockSuppressEmailAddress).toHaveBeenCalledWith({
      email: "Bounce@Example.com",
      reason: "bounced",
      source: "resend_webhook",
      eventType: "email.bounced",
      providerMessageId: "email-1",
      rawEvent: event,
    });
  });

  it("does not suppress delivered events", async () => {
    const event = {
      type: "email.delivered",
      data: { email_id: "email-1", to: "ok@example.com" },
    };
    mockVerify.mockReturnValue(event);

    const res = await POST(webhookRequest(event));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, suppressed: 0 });
    expect(mockSuppressEmailAddress).not.toHaveBeenCalled();
  });
});
