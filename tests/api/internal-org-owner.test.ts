import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockOrgMemberFindMany } = vi.hoisted(() => ({
  mockOrgMemberFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgMember: {
      findMany: mockOrgMemberFindMany,
    },
  },
}));

process.env.ENGRAM_INTERNAL_API_KEY = "test-internal-key-engram-p3";

import { GET } from "@/app/api/internal/orgs/[orgId]/owner/route";

const VALID_KEY = "test-internal-key-engram-p3";
const ORG_ID = "org-abc123";

function makeRequest(options: { key?: string | null } = {}) {
  const headers: Record<string, string> = {};
  if (options.key !== null) {
    headers["x-internal-api-key"] = options.key ?? VALID_KEY;
  }
  return new NextRequest(`https://login.dev.ctxhost.com/api/internal/orgs/${ORG_ID}/owner`, {
    method: "GET",
    headers,
  });
}

async function callGET(req: NextRequest) {
  return GET(req, { params: Promise.resolve({ orgId: ORG_ID }) });
}

describe("GET /api/internal/orgs/[orgId]/owner", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 404 with no API key", async () => {
    const res = await callGET(makeRequest({ key: null }));
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns 404 with wrong API key", async () => {
    const res = await callGET(makeRequest({ key: "wrong-key" }));
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not query DB when key is absent", async () => {
    await callGET(makeRequest({ key: null }));
    expect(mockOrgMemberFindMany).not.toHaveBeenCalled();
  });

  it("returns 404 when org has no OWNER", async () => {
    mockOrgMemberFindMany.mockResolvedValueOnce([]);
    const res = await callGET(makeRequest());
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns owner and owners on valid key + single OWNER", async () => {
    mockOrgMemberFindMany.mockResolvedValueOnce([
      { user: { id: "user-xyz", email: "owner@example.com", displayName: "Alice" } },
    ]);
    const res = await callGET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      orgId: ORG_ID,
      owner: { engramUserId: "user-xyz", email: "owner@example.com", displayName: "Alice" },
      owners: [{ engramUserId: "user-xyz", email: "owner@example.com", displayName: "Alice" }],
    });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns all co-owners in owners array (ADR-022 amendment 2026-06-16)", async () => {
    mockOrgMemberFindMany.mockResolvedValueOnce([
      { user: { id: "user-primary", email: "primary@example.com", displayName: "Alice" } },
      { user: { id: "user-coowner", email: "co@example.com", displayName: "Bob" } },
    ]);
    const res = await callGET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.owners).toHaveLength(2);
    expect(body.owners[0].engramUserId).toBe("user-primary");
    expect(body.owners[1].engramUserId).toBe("user-coowner");
    // backward-compat: owner === first entry
    expect(body.owner.engramUserId).toBe("user-primary");
  });

  it("returns owner with null displayName when unset", async () => {
    mockOrgMemberFindMany.mockResolvedValueOnce([
      { user: { id: "user-xyz", email: "owner@example.com", displayName: null } },
    ]);
    const res = await callGET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.owner.displayName).toBeNull();
    expect(body.owners[0].displayName).toBeNull();
  });

  it("queries with OWNER role, asc createdAt + id ordering", async () => {
    mockOrgMemberFindMany.mockResolvedValueOnce([
      { user: { id: "user-1", email: "a@b.com", displayName: null } },
    ]);
    await callGET(makeRequest());
    expect(mockOrgMemberFindMany).toHaveBeenCalledWith({
      where: { orgId: ORG_ID, role: "OWNER" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        user: {
          select: { id: true, email: true, displayName: true },
        },
      },
    });
  });
});
