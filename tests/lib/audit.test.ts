import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockAuditCreate } = vi.hoisted(() => ({
  mockAuditCreate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { auditLog: { create: mockAuditCreate } },
}));

import { recordAuditEvent } from "@/lib/audit";

function makeRequest(headers: Record<string, string> = {}) {
  return new NextRequest("https://login.dev.ctxhost.com/api/auth/login", {
    method: "POST",
    headers,
  });
}

describe("recordAuditEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditCreate.mockResolvedValue({});
  });

  it("writes a row with the event fields, derived IP and user-agent", async () => {
    await recordAuditEvent({
      action: "login.success",
      outcome: "success",
      actorUserId: "user-1",
      targetType: "user",
      targetId: "user-1",
      request: makeRequest({
        "x-forwarded-for": "9.9.9.9, 203.0.113.5",
        "user-agent": "Mozilla/5.0",
      }),
    });

    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
    const data = mockAuditCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({
      action: "login.success",
      outcome: "success",
      actorUserId: "user-1",
      actorType: "user", // default
      targetType: "user",
      targetId: "user-1",
      ip: "203.0.113.5", // last XFF entry (proxy-appended)
      userAgent: "Mozilla/5.0",
    });
  });

  it("defaults nullable fields and truncates a long user-agent", async () => {
    await recordAuditEvent({
      action: "login.failure",
      outcome: "failure",
      actorType: "anonymous",
      request: makeRequest({ "user-agent": "x".repeat(5000) }),
    });

    const data = mockAuditCreate.mock.calls[0][0].data;
    expect(data.actorUserId).toBeNull();
    expect(data.targetType).toBeNull();
    expect(data.orgId).toBeNull();
    expect(data.userAgent.length).toBe(1024);
  });

  it("never throws when the DB write fails (best-effort)", async () => {
    mockAuditCreate.mockRejectedValue(new Error("db down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      recordAuditEvent({ action: "login.success", outcome: "success" }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("records without a request (no ip/user-agent)", async () => {
    await recordAuditEvent({
      action: "admin.user.create",
      outcome: "success",
      actorUserId: "admin-1",
      actorType: "admin",
    });

    const data = mockAuditCreate.mock.calls[0][0].data;
    expect(data.ip).toBeNull();
    expect(data.userAgent).toBeNull();
  });
});
