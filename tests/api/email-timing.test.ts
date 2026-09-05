import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockGetEmailIdentityForClient, mockSendEmailBestEffort, mockSettleAfter } = vi.hoisted(
  () => ({
    mockGetEmailIdentityForClient: vi.fn(),
    mockSendEmailBestEffort: vi.fn(),
    mockSettleAfter: vi.fn(),
  }),
);

vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    getEmailIdentityForClient: mockGetEmailIdentityForClient,
    sendEmailBestEffort: mockSendEmailBestEffort,
    settleAfter: mockSettleAfter,
  };
});

import { mockPrisma } from "../mocks/prisma";
import { POST } from "@/app/api/waitlist/route";

function request(body: object) {
  return new NextRequest(
    new Request("http://localhost:3104/api/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const identity = {
  clientId: "tradepost-web",
  brandName: "CCG Tradepost",
  fromName: "CCG Tradepost",
  fromAddress: "noreply@ccgtradepost.com",
  from: "CCG Tradepost <noreply@ccgtradepost.com>",
  primaryColor: "#000",
  templateTheme: "tradepost" as const,
  securedByEngram: true,
};

describe("waitlist email delivery is not dropped on Lambda", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEmailIdentityForClient.mockResolvedValue(identity);
    mockSettleAfter.mockResolvedValue(undefined);
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.waitlistRequest.upsert.mockResolvedValue({});
  });

  // Regression: the send was fire-and-forget. That works on a long-running
  // container but is silently dropped on Lambda, whose execution environment
  // freezes the moment the response is returned. Asserting at the ROUTE level
  // (not inside lib/email) is what makes this catch a reverted call site.
  it("does not return until the send has settled", async () => {
    let sendSettled = false;
    mockSendEmailBestEffort.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            sendSettled = true;
            resolve();
          }, 20);
        }),
    );

    await POST(request({ email: "new@example.com", clientId: "tradepost-web" }));

    expect(sendSettled).toBe(true);
  });

  // Both branches must be padded to the same floor, or response time reveals
  // which addresses already have accounts (audit N-2). This route has no rate
  // limiter, so the oracle would be freely samplable.
  it("pads the response on the no-account path (which sends mail)", async () => {
    mockSendEmailBestEffort.mockResolvedValue(undefined);

    await POST(request({ email: "new@example.com" }));

    expect(mockSendEmailBestEffort).toHaveBeenCalledTimes(1);
    expect(mockSettleAfter).toHaveBeenCalledTimes(1);
  });

  it("pads the response on the existing-account path (which sends nothing)", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: "u1", email: "known@example.com" });

    await POST(request({ email: "known@example.com" }));

    expect(mockSendEmailBestEffort).not.toHaveBeenCalled();
    expect(mockSettleAfter).toHaveBeenCalledTimes(1);
  });
});
