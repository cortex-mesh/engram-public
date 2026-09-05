import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockOrganizationFindUnique } = vi.hoisted(() => ({
  mockOrganizationFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    organization: {
      findUnique: mockOrganizationFindUnique,
    },
  },
}));

import { GET } from "@/app/api/internal/tls/allow/route";

function makeRequest(url: string, host = "127.0.0.1:3104") {
  return new NextRequest(url, {
    headers: {
      host,
    },
  });
}

describe("/api/internal/tls/allow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows existing organization tenant hostnames for local Caddy requests", async () => {
    mockOrganizationFindUnique.mockResolvedValue({ id: "org-demo" });

    const response = await GET(
      makeRequest("http://127.0.0.1:3104/api/internal/tls/allow?domain=demo.dev.ctxhost.com"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      allowed: true,
      hostname: "demo.dev.ctxhost.com",
      slug: "demo",
    });
    expect(mockOrganizationFindUnique).toHaveBeenCalledWith({
      where: { slug: "demo" },
      select: { id: true },
    });
  });

  it("denies unknown tenant hostnames", async () => {
    mockOrganizationFindUnique.mockResolvedValue(null);

    const response = await GET(
      makeRequest("http://127.0.0.1:3104/api/internal/tls/allow?domain=unknown.dev.ctxhost.com"),
    );

    expect(response.status).toBe(404);
  });

  it("denies reserved tenant hostnames before querying the database", async () => {
    const response = await GET(
      makeRequest("http://127.0.0.1:3104/api/internal/tls/allow?domain=login.dev.ctxhost.com"),
    );

    expect(response.status).toBe(404);
    expect(mockOrganizationFindUnique).not.toHaveBeenCalled();
  });

  it("denies public requests even when the domain is valid", async () => {
    const response = await GET(
      makeRequest(
        "https://login.dev.ctxhost.com/api/internal/tls/allow?domain=demo.dev.ctxhost.com",
        "login.dev.ctxhost.com",
      ),
    );

    expect(response.status).toBe(404);
    expect(mockOrganizationFindUnique).not.toHaveBeenCalled();
  });
});
