import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { mockPrisma } from "../../mocks/prisma";
import { sha256 } from "@/lib/crypto";
import { POST } from "@/app/api/auth/logout/route";

function makeRequest(options?: { cookie?: string; body?: object }) {
  return new NextRequest(
    new Request("https://login.dev.ctxhost.com/api/auth/logout", {
      method: "POST",
      headers: options?.body
        ? { "Content-Type": "application/json", ...(options.cookie ? { cookie: options.cookie } : {}) }
        : options?.cookie
          ? { cookie: options.cookie }
          : undefined,
      body: options?.body ? JSON.stringify(options.body) : undefined,
    }),
  );
}

describe("POST /api/auth/logout", () => {
  beforeEach(() => {
    Object.values(mockPrisma).forEach((model) => {
      Object.values(model).forEach((fn) => (fn as any).mockReset());
    });
  });

  it("revokes a cookie refresh token", async () => {
    mockPrisma.refreshToken.deleteMany.mockResolvedValue({ count: 1 });

    const response = await POST(makeRequest({ cookie: "engram-refresh=refresh-1" }));

    expect(response.status).toBe(200);
    expect(mockPrisma.refreshToken.deleteMany).toHaveBeenCalledWith({
      where: { tokenHash: { in: [sha256("refresh-1")] } },
    });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "logout.success" }),
      }),
    );
  });

  it("revokes every presented refresh cookie variant", async () => {
    // Host-only + domain-scoped cookies share a name; the browser sends both.
    mockPrisma.refreshToken.deleteMany.mockResolvedValue({ count: 2 });

    const response = await POST(
      makeRequest({ cookie: "engram-refresh=refresh-a; engram-refresh=refresh-b" }),
    );

    expect(response.status).toBe(200);
    expect(mockPrisma.refreshToken.deleteMany).toHaveBeenCalledWith({
      where: { tokenHash: { in: [sha256("refresh-a"), sha256("refresh-b")] } },
    });
  });

  it("revokes a native body refresh token", async () => {
    mockPrisma.refreshToken.deleteMany.mockResolvedValue({ count: 1 });

    const response = await POST(makeRequest({ body: { refreshToken: "refresh-2" } }));

    expect(response.status).toBe(200);
    expect(mockPrisma.refreshToken.deleteMany).toHaveBeenCalledWith({
      where: { tokenHash: { in: [sha256("refresh-2")] } },
    });
  });

  it("expires both auth cookies on logout", async () => {
    mockPrisma.refreshToken.deleteMany.mockResolvedValue({ count: 1 });

    const response = await POST(makeRequest({ cookie: "engram-refresh=refresh-1" }));

    const setCookies = response.headers.getSetCookie();
    const expired = (name: string) =>
      setCookies.filter((c) => c.startsWith(`${name}=;`) && c.includes("Max-Age=0"));
    expect(expired("engram-access").length).toBeGreaterThanOrEqual(1);
    expect(expired("engram-refresh").length).toBeGreaterThanOrEqual(1);
  });
});
