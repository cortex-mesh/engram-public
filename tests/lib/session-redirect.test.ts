import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockVerifyToken, mockFindUnique } = vi.hoisted(() => ({
  mockVerifyToken: vi.fn(),
  mockFindUnique: vi.fn(),
}));

vi.mock("@/lib/jwt", () => ({ verifyToken: mockVerifyToken }));
vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: mockFindUnique } },
}));

import { resolvePostLoginTarget } from "@/lib/session-redirect";

describe("resolvePostLoginTarget", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null when no access token is provided", async () => {
    await expect(resolvePostLoginTarget(undefined)).resolves.toBeNull();
  });

  it("returns null for an empty string token", async () => {
    await expect(resolvePostLoginTarget("")).resolves.toBeNull();
  });

  it("returns null when token verification throws", async () => {
    mockVerifyToken.mockRejectedValue(new Error("invalid jwt"));
    await expect(resolvePostLoginTarget("bad-token")).resolves.toBeNull();
  });

  it("returns null for a non-access token type", async () => {
    mockVerifyToken.mockResolvedValue({ userId: "user-1", type: "refresh" });
    await expect(resolvePostLoginTarget("refresh-token")).resolves.toBeNull();
  });

  it("redirects superadmin to the platform admin URL", async () => {
    mockVerifyToken.mockResolvedValue({ userId: "admin-1", type: "access", role: "SUPERADMIN" });
    mockFindUnique.mockResolvedValue({ lastOrgId: null, orgMembers: [] });
    const target = await resolvePostLoginTarget("admin-token");
    expect(target).toBeTruthy();
    expect(target).toContain("platform");
  });

  it("redirects a single-org user to their tenant workspace (not /login or /account)", async () => {
    mockVerifyToken.mockResolvedValue({ userId: "user-1", type: "access", role: "USER" });
    mockFindUnique.mockResolvedValue({
      lastOrgId: null,
      orgMembers: [{ org: { id: "org-1", slug: "cortex" } }],
    });
    const target = await resolvePostLoginTarget("user-token");
    // Must be a workspace URL containing the org slug, never /login
    expect(target).toBeTruthy();
    expect(target).toContain("cortex");
    expect(target).not.toBe("/login");
    expect(target).not.toBe("/account");
  });

  it("routes a multi-org user to their lastOrgId when set and valid", async () => {
    mockVerifyToken.mockResolvedValue({ userId: "user-1", type: "access", role: "USER" });
    mockFindUnique.mockResolvedValue({
      lastOrgId: "org-2",
      orgMembers: [
        { org: { id: "org-1", slug: "cortex" } },
        { org: { id: "org-2", slug: "demo" } },
      ],
    });
    const target = await resolvePostLoginTarget("multi-org-token");
    expect(target).toContain("demo");
    expect(target).not.toBe("/account");
  });

  it("routes a multi-org user to the oldest org when lastOrgId is unset", async () => {
    mockVerifyToken.mockResolvedValue({ userId: "user-1", type: "access", role: "USER" });
    mockFindUnique.mockResolvedValue({
      lastOrgId: null,
      orgMembers: [
        { org: { id: "org-1", slug: "cortex" } },
        { org: { id: "org-2", slug: "demo" } },
      ],
    });
    const target = await resolvePostLoginTarget("multi-org-token");
    expect(target).toContain("cortex");
    expect(target).not.toBe("/account");
  });

  it("falls back to oldest org when lastOrgId is stale (no longer a membership)", async () => {
    mockVerifyToken.mockResolvedValue({ userId: "user-1", type: "access", role: "USER" });
    mockFindUnique.mockResolvedValue({
      lastOrgId: "org-removed",
      orgMembers: [
        { org: { id: "org-1", slug: "cortex" } },
        { org: { id: "org-2", slug: "demo" } },
      ],
    });
    const target = await resolvePostLoginTarget("stale-org-token");
    expect(target).toContain("cortex");
  });

  it("returns /account when user has no org memberships", async () => {
    mockVerifyToken.mockResolvedValue({ userId: "user-1", type: "access", role: "USER" });
    mockFindUnique.mockResolvedValue({ lastOrgId: null, orgMembers: [] });
    const target = await resolvePostLoginTarget("orphan-token");
    expect(target).toBe("/account");
  });

  it("returns /account when user record is not found", async () => {
    mockVerifyToken.mockResolvedValue({ userId: "missing-user", type: "access", role: "USER" });
    mockFindUnique.mockResolvedValue(null);
    const target = await resolvePostLoginTarget("orphan-token");
    expect(target).toBe("/account");
  });

  // Invariant: a valid access token must never produce /login as the target.
  // If this ever returns /login and the caller does redirect(target ?? "/login"),
  // valid sessions would loop back to login instead of landing somewhere useful.
  it("never returns /login for any valid access token", async () => {
    const cases = [
      { role: "USER", lastOrgId: null, orgMembers: [{ org: { id: "org-1", slug: "cortex" } }] },
      { role: "USER", lastOrgId: "org-1", orgMembers: [{ org: { id: "org-1", slug: "cortex" } }, { org: { id: "org-2", slug: "demo" } }] },
      { role: "USER", lastOrgId: null, orgMembers: [{ org: { id: "org-1", slug: "a" } }, { org: { id: "org-2", slug: "b" } }] },
      { role: "USER", lastOrgId: null, orgMembers: [] },
      { role: "SUPERADMIN", lastOrgId: null, orgMembers: [] },
    ];
    for (const { role, lastOrgId, orgMembers } of cases) {
      mockVerifyToken.mockResolvedValue({ userId: "u", type: "access", role });
      mockFindUnique.mockResolvedValue({ lastOrgId, orgMembers });
      const target = await resolvePostLoginTarget("token");
      expect(target).not.toBeNull();
      expect(target).not.toBe("/login");
    }
  });
});
