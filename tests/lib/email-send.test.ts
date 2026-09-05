import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();
const { mockEmailSuppressionFindUnique } = vi.hoisted(() => ({
  mockEmailSuppressionFindUnique: vi.fn(),
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send };
  },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    emailSuppression: {
      findUnique: mockEmailSuppressionFindUnique,
    },
  },
}));

import {
  AUTH_RESPONSE_FLOOR_MS,
  authResponseFloorMs,
  sendEmailBestEffort,
  sendEmailRequired,
  settleAfter,
} from "@/lib/email";

const payload = {
  to: "someone@example.com",
  subject: "hello",
  html: "<p>hello</p>",
  from: "CCG Tradepost <noreply@ccgtradepost.com>",
};

describe("sendEmailBestEffort", () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test";
    send.mockReset();
    mockEmailSuppressionFindUnique.mockReset();
    mockEmailSuppressionFindUnique.mockResolvedValue(null);
  });

  // Regression: this shipped as fire-and-forget, which works on a long-running
  // container but is silently dropped on Lambda, where the execution
  // environment freezes the moment the response is returned. Production
  // accepted signups and sent nothing, with no error and no log.
  it("does not resolve until the underlying send has settled", async () => {
    let settled = false;
    send.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            settled = true;
            resolve({ data: { id: "abc" }, error: null });
          }, 10);
        }),
    );

    await sendEmailBestEffort(payload);

    expect(settled).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("swallows provider errors so callers stay enumeration-safe", async () => {
    send.mockResolvedValue({
      data: null,
      error: { message: "not authorized to send from ccgtradepost.com" },
    });

    await expect(sendEmailBestEffort(payload)).resolves.toBeUndefined();
  });

  it("swallows thrown provider failures", async () => {
    send.mockRejectedValue(new Error("network down"));

    await expect(sendEmailBestEffort(payload)).resolves.toBeUndefined();
  });

  it("logs and skips suppressed best-effort sends before calling Resend", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockEmailSuppressionFindUnique.mockResolvedValue({
      email: "someone@example.com",
      reason: "bounced",
      source: "resend_webhook",
      eventType: "email.bounced",
      providerMessageId: "email-1",
      updatedAt: new Date(),
    });

    await expect(sendEmailBestEffort(payload)).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledWith(
      "Suppressed email send skipped:",
      "someone@example.com suppressed because bounced (email.bounced)",
    );
    consoleWarn.mockRestore();
  });
});

describe("sendEmailRequired", () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test";
    send.mockReset();
    mockEmailSuppressionFindUnique.mockReset();
    mockEmailSuppressionFindUnique.mockResolvedValue(null);
  });

  it("throws on suppressed required sends so callers cannot report success", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockEmailSuppressionFindUnique.mockResolvedValue({
      email: "someone@example.com",
      reason: "complained",
      source: "resend_webhook",
      eventType: "email.complained",
      providerMessageId: "email-2",
      updatedAt: new Date(),
    });

    await expect(sendEmailRequired(payload)).rejects.toThrow("Email address is suppressed: complained");

    expect(send).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledWith(
      "Suppressed required email blocked:",
      "someone@example.com suppressed because complained (email.complained)",
    );
    consoleWarn.mockRestore();
  });
});

describe("settleAfter", () => {
  // The constant-time floor is what lets the awaited send coexist with the
  // account-enumeration protection from audit N-2.
  it("pads a fast path up to the floor", async () => {
    const started = Date.now();
    await settleAfter(started, 60);
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });

  it("does not pad a path that already exceeded the floor", async () => {
    const before = Date.now();
    await settleAfter(Date.now() - 500, 60);
    expect(Date.now() - before).toBeLessThan(30);
  });
});

describe("constant-time contract", () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test";
    send.mockReset();
    mockEmailSuppressionFindUnique.mockReset();
    mockEmailSuppressionFindUnique.mockResolvedValue(null);
  });

  // A floor alone is not enough. If a slow provider could push the sending
  // path past the floor, it would finish later than the non-sending path and
  // response time would enumerate accounts again — the very oracle the floor
  // exists to close. The send budget is therefore derived from the time left
  // until the deadline, so the send is capped, not just padded.
  it("a hung provider is capped rather than stalling to the Lambda timeout", async () => {
    send.mockImplementation(() => new Promise(() => {})); // never settles

    const startedAt = Date.now();
    await sendEmailBestEffort({ ...payload, budgetMs: 200 });

    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(600);
  });

  // The cap must never be tight enough to trim a healthy send: squeezing the
  // budget to fit the response floor dropped cold-start mail (DNS + TLS + HTTP
  // to the provider does not fit in the leftovers), which is the exact bug
  // this whole change exists to fix.
  it("a slow-but-healthy send still completes under the default cap", async () => {
    let delivered = false;
    send.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            delivered = true;
            resolve({ data: { id: "x" }, error: null });
          }, 700),
        ),
    );

    await sendEmailBestEffort(payload); // default cap, no deadline squeeze

    expect(delivered).toBe(true);
  });

  it("a fast send and a no-send path land in the same band", async () => {
    send.mockResolvedValue({ data: { id: "x" }, error: null });

    const sendStart = Date.now();
    await sendEmailBestEffort(payload);
    await settleAfter(sendStart, 300);
    const withSend = Date.now() - sendStart;

    const skipStart = Date.now();
    await settleAfter(skipStart, 300);
    const withoutSend = Date.now() - skipStart;

    expect(Math.abs(withSend - withoutSend)).toBeLessThan(60);
  });

  it("falls back to the real floor if the test override is malformed", () => {
    const prev = process.env.ENGRAM_AUTH_RESPONSE_FLOOR_MS;
    process.env.ENGRAM_AUTH_RESPONSE_FLOOR_MS = "not-a-number";
    expect(authResponseFloorMs()).toBe(AUTH_RESPONSE_FLOOR_MS);
    if (prev === undefined) delete process.env.ENGRAM_AUTH_RESPONSE_FLOOR_MS;
    else process.env.ENGRAM_AUTH_RESPONSE_FLOOR_MS = prev;
  });
});
