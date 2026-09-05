import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Hoisted mocks must be declared before any imports that use them
const {
  mockAuthenticateRequest,
  mockIsCurrentPlatformSuperadmin,
  mockOrgMemberFindFirst,
  mockOrgMemberFindMany,
  mockOrgMemberCount,
  mockOrgMemberCreate,
  mockOrgMemberUpdate,
  mockOrgMemberDeleteMany,
  mockOrgInviteFindFirst,
  mockOrgInviteFindMany,
  mockOrgInviteCreate,
  mockOrgInviteUpdate,
  mockOrgFindUnique,
  mockUserFindFirst,
  mockUserAppEntitlementDeleteMany,
  mockTransaction,
  mockAuditLogFindMany,
  mockRecordAuditEvent,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockIsCurrentPlatformSuperadmin: vi.fn(),
  mockOrgMemberFindFirst: vi.fn(),
  mockOrgMemberFindMany: vi.fn(),
  mockOrgMemberCount: vi.fn(),
  mockOrgMemberCreate: vi.fn(),
  mockOrgMemberUpdate: vi.fn(),
  mockOrgMemberDeleteMany: vi.fn(),
  mockOrgInviteFindFirst: vi.fn(),
  mockOrgInviteFindMany: vi.fn(),
  mockOrgInviteCreate: vi.fn(),
  mockOrgInviteUpdate: vi.fn(),
  mockOrgFindUnique: vi.fn(),
  mockUserFindFirst: vi.fn(),
  mockUserAppEntitlementDeleteMany: vi.fn(),
  mockTransaction: vi.fn(async (ops) => Promise.all(ops)),
  mockAuditLogFindMany: vi.fn(),
  mockRecordAuditEvent: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authenticateRequest: mockAuthenticateRequest,
  isCurrentPlatformSuperadmin: mockIsCurrentPlatformSuperadmin,
}));

vi.mock("@/lib/audit", () => ({
  recordAuditEvent: mockRecordAuditEvent,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mockTransaction,
    orgMember: {
      findFirst: mockOrgMemberFindFirst,
      findMany: mockOrgMemberFindMany,
      count: mockOrgMemberCount,
      create: mockOrgMemberCreate,
      update: mockOrgMemberUpdate,
      deleteMany: mockOrgMemberDeleteMany,
    },
    orgInvite: {
      findFirst: mockOrgInviteFindFirst,
      findMany: mockOrgInviteFindMany,
      create: mockOrgInviteCreate,
      update: mockOrgInviteUpdate,
    },
    organization: {
      findUnique: mockOrgFindUnique,
    },
    user: {
      findFirst: mockUserFindFirst,
    },
    userAppEntitlement: {
      deleteMany: mockUserAppEntitlementDeleteMany,
    },
    auditLog: {
      findMany: mockAuditLogFindMany,
    },
  },
}));

import { GET as getMembersRoute, POST as postMembersRoute } from "@/app/api/orgs/[orgId]/members/route";
import { PATCH as patchMemberRoute, DELETE as deleteMemberRoute } from "@/app/api/orgs/[orgId]/members/[userId]/route";
import { GET as getInvitesRoute, POST as postInvitesRoute } from "@/app/api/orgs/[orgId]/invites/route";
import { DELETE as deleteInviteRoute } from "@/app/api/orgs/[orgId]/invites/[inviteId]/route";
import { GET as getAuditRoute } from "@/app/api/orgs/[orgId]/audit/route";

const ORG_ID = "org-1";
const OWNER_USER_ID = "user-owner";
const ADMIN_USER_ID = "user-admin";
const MEMBER_USER_ID = "user-member";
const TARGET_USER_ID = "user-target";

function makeRequest(
  method: string,
  url: string,
  opts: { body?: Record<string, unknown>; bearer?: boolean; cookie?: boolean } = {},
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.bearer) {
    headers["Authorization"] = "Bearer jwt-token";
  } else if (opts.cookie !== false) {
    headers["Cookie"] = "engram-access=jwt-token";
    headers["Sec-Fetch-Site"] = "same-origin";
  }
  return new NextRequest(url, {
    method,
    headers,
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
}

function membersListUrl() {
  return `https://login.dev.ctxhost.com/api/orgs/${ORG_ID}/members`;
}
function memberDetailUrl(userId = TARGET_USER_ID) {
  return `https://login.dev.ctxhost.com/api/orgs/${ORG_ID}/members/${userId}`;
}
function invitesListUrl() {
  return `https://login.dev.ctxhost.com/api/orgs/${ORG_ID}/invites`;
}
function inviteDetailUrl(inviteId = "invite-1") {
  return `https://login.dev.ctxhost.com/api/orgs/${ORG_ID}/invites/${inviteId}`;
}
function auditUrl() {
  return `https://login.dev.ctxhost.com/api/orgs/${ORG_ID}/audit`;
}

const fakeMembership = (role: string) => ({ role, createdAt: new Date("2026-01-01"), user: { id: TARGET_USER_ID, email: "target@x.com", username: "target", displayName: "Target", role: "USER" } });
const fakeInvite = (overrides = {}) => ({ id: "invite-1", email: "invitee@x.com", role: "MEMBER", createdAt: new Date("2026-01-01"), acceptedAt: null, revokedAt: null, ...overrides });

beforeEach(() => {
  // resetAllMocks clears the mockResolvedValueOnce queue AND implementations.
  // clearAllMocks only clears call history, which lets leftover once-queue items
  // from short-circuited tests pollute subsequent tests.
  vi.resetAllMocks();
  process.env.ENGRAM_ALLOWED_ORIGINS = "";
  mockIsCurrentPlatformSuperadmin.mockResolvedValue(false);
  mockRecordAuditEvent.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Authorization baseline: MEMBER and outsiders are denied
// ---------------------------------------------------------------------------

describe("authorization: MEMBER and non-member denied on all routes", () => {
  function setupMember(orgRole: string) {
    mockAuthenticateRequest.mockResolvedValue({ userId: MEMBER_USER_ID, role: "USER" });
    // findFirst for authorizeOrgAdminRequest returns a non-manager membership
    mockOrgMemberFindFirst.mockResolvedValue({ role: orgRole });
  }

  it("GET /members: MEMBER gets 403", async () => {
    setupMember("MEMBER");
    const res = await getMembersRoute(makeRequest("GET", membersListUrl()), { params: Promise.resolve({ orgId: ORG_ID }) });
    expect(res.status).toBe(403);
  });

  it("POST /members: MEMBER gets 403", async () => {
    setupMember("MEMBER");
    const res = await postMembersRoute(makeRequest("POST", membersListUrl(), { body: { email: "a@b.com", role: "MEMBER" } }), { params: Promise.resolve({ orgId: ORG_ID }) });
    expect(res.status).toBe(403);
  });

  it("PATCH /members/:userId: MEMBER gets 403", async () => {
    setupMember("MEMBER");
    const res = await patchMemberRoute(makeRequest("PATCH", memberDetailUrl(), { body: { role: "MEMBER" } }), { params: Promise.resolve({ orgId: ORG_ID, userId: TARGET_USER_ID }) });
    expect(res.status).toBe(403);
  });

  it("DELETE /members/:userId: MEMBER gets 403", async () => {
    setupMember("MEMBER");
    const res = await deleteMemberRoute(makeRequest("DELETE", memberDetailUrl()), { params: Promise.resolve({ orgId: ORG_ID, userId: TARGET_USER_ID }) });
    expect(res.status).toBe(403);
  });

  it("GET /invites: non-member of org gets 403", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: OWNER_USER_ID, role: "USER" });
    // user is owner of org-2, not org-1
    mockOrgMemberFindFirst.mockResolvedValue(null);
    const res = await getInvitesRoute(makeRequest("GET", invitesListUrl()), { params: Promise.resolve({ orgId: ORG_ID }) });
    expect(res.status).toBe(403);
  });

  it("DELETE /invites/:id: MEMBER gets 403", async () => {
    setupMember("MEMBER");
    const res = await deleteInviteRoute(makeRequest("DELETE", inviteDetailUrl()), { params: Promise.resolve({ orgId: ORG_ID, inviteId: "invite-1" }) });
    expect(res.status).toBe(403);
  });

  it("GET /audit: MEMBER gets 403", async () => {
    setupMember("MEMBER");
    const res = await getAuditRoute(makeRequest("GET", auditUrl()), { params: Promise.resolve({ orgId: ORG_ID }) });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// OWNER of org-1 can read and manage
// ---------------------------------------------------------------------------

describe("OWNER: full read+write access", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockResolvedValue({ userId: OWNER_USER_ID, role: "USER" });
    mockOrgMemberFindFirst.mockResolvedValue({ role: "OWNER" });
  });

  it("GET /members returns member list", async () => {
    mockOrgMemberFindMany.mockResolvedValue([fakeMembership("MEMBER")]);
    const res = await getMembersRoute(makeRequest("GET", membersListUrl()), { params: Promise.resolve({ orgId: ORG_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { members: unknown[] };
    expect(body.members).toHaveLength(1);
  });

  it("GET /members omits email for non-superadmin caller", async () => {
    mockOrgMemberFindMany.mockResolvedValue([fakeMembership("MEMBER")]);
    const res = await getMembersRoute(makeRequest("GET", membersListUrl()), { params: Promise.resolve({ orgId: ORG_ID }) });
    const body = await res.json() as { members: Array<Record<string, unknown>> };
    expect(body.members[0]).not.toHaveProperty("email");
  });

  it("OWNER can add a MEMBER", async () => {
    mockOrgFindUnique.mockResolvedValue({ id: ORG_ID });
    mockUserFindFirst.mockResolvedValue({ id: TARGET_USER_ID, email: "target@x.com", username: "target", displayName: null, role: "USER" });
    mockOrgMemberCreate.mockResolvedValue(fakeMembership("MEMBER"));
    const res = await postMembersRoute(makeRequest("POST", membersListUrl(), { body: { email: "target@x.com", role: "MEMBER" } }), { params: Promise.resolve({ orgId: ORG_ID }) });
    expect(res.status).toBe(201);
  });

  it("OWNER can add a new OWNER", async () => {
    mockOrgFindUnique.mockResolvedValue({ id: ORG_ID });
    mockUserFindFirst.mockResolvedValue({ id: TARGET_USER_ID, email: "target@x.com", username: "target", displayName: null, role: "USER" });
    mockOrgMemberCreate.mockResolvedValue(fakeMembership("OWNER"));
    const res = await postMembersRoute(makeRequest("POST", membersListUrl(), { body: { email: "target@x.com", role: "OWNER" } }), { params: Promise.resolve({ orgId: ORG_ID }) });
    expect(res.status).toBe(201);
  });

  it("GET /invites returns pending invites", async () => {
    mockOrgInviteFindMany.mockResolvedValue([fakeInvite()]);
    const res = await getInvitesRoute(makeRequest("GET", invitesListUrl()), { params: Promise.resolve({ orgId: ORG_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { invites: unknown[] };
    expect(body.invites).toHaveLength(1);
  });

  it("OWNER can revoke a pending invite", async () => {
    mockOrgInviteFindFirst.mockResolvedValue(fakeInvite());
    mockOrgInviteUpdate.mockResolvedValue({});
    const res = await deleteInviteRoute(makeRequest("DELETE", inviteDetailUrl()), { params: Promise.resolve({ orgId: ORG_ID, inviteId: "invite-1" }) });
    expect(res.status).toBe(200);
  });

  it("GET /audit returns audit log", async () => {
    mockAuditLogFindMany.mockResolvedValue([
      { id: "ev-1", createdAt: new Date("2026-01-01"), action: "org.member.add", outcome: "success", actorUserId: OWNER_USER_ID, actorType: "user", targetType: "user", targetId: TARGET_USER_ID, metadata: {} },
    ]);
    const res = await getAuditRoute(makeRequest("GET", auditUrl()), { params: Promise.resolve({ orgId: ORG_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { events: unknown[] };
    expect(body.events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ADMIN: access but blocked from granting OWNER role
// ---------------------------------------------------------------------------

describe("ADMIN: access gated on escalation guard", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockResolvedValue({ userId: ADMIN_USER_ID, role: "USER" });
    mockOrgMemberFindFirst.mockResolvedValue({ role: "ADMIN" });
  });

  it("ADMIN can add a MEMBER", async () => {
    mockOrgFindUnique.mockResolvedValue({ id: ORG_ID });
    mockUserFindFirst.mockResolvedValue({ id: TARGET_USER_ID, email: "t@x.com", username: "t", displayName: null, role: "USER" });
    mockOrgMemberCreate.mockResolvedValue(fakeMembership("MEMBER"));
    const res = await postMembersRoute(makeRequest("POST", membersListUrl(), { body: { email: "t@x.com", role: "MEMBER" } }), { params: Promise.resolve({ orgId: ORG_ID }) });
    expect(res.status).toBe(201);
  });

  it("ADMIN cannot add an OWNER", async () => {
    const res = await postMembersRoute(makeRequest("POST", membersListUrl(), { body: { email: "t@x.com", role: "OWNER" } }), { params: Promise.resolve({ orgId: ORG_ID }) });
    expect(res.status).toBe(403);
  });

  it("ADMIN cannot invite as OWNER", async () => {
    const res = await postInvitesRoute(makeRequest("POST", invitesListUrl(), { body: { email: "t@x.com", role: "OWNER" } }), { params: Promise.resolve({ orgId: ORG_ID }) });
    expect(res.status).toBe(403);
  });

  it("ADMIN cannot change a member to OWNER", async () => {
    mockOrgMemberFindFirst
      .mockResolvedValueOnce({ role: "ADMIN" }) // guard membership check
      .mockResolvedValueOnce({ id: "m-1", role: "MEMBER", user: { role: "USER" } }); // target membership
    const res = await patchMemberRoute(makeRequest("PATCH", memberDetailUrl(), { body: { role: "OWNER" } }), { params: Promise.resolve({ orgId: ORG_ID, userId: TARGET_USER_ID }) });
    expect(res.status).toBe(403);
  });

  it("ADMIN can change a member to ADMIN", async () => {
    mockOrgMemberFindFirst
      .mockResolvedValueOnce({ role: "ADMIN" }) // guard
      .mockResolvedValueOnce({ id: "m-1", role: "MEMBER", user: { role: "USER" } }); // target
    mockOrgMemberUpdate.mockResolvedValue(fakeMembership("ADMIN"));
    const res = await patchMemberRoute(makeRequest("PATCH", memberDetailUrl(), { body: { role: "ADMIN" } }), { params: Promise.resolve({ orgId: ORG_ID, userId: TARGET_USER_ID }) });
    expect(res.status).toBe(200);
  });

  it("ADMIN cannot demote an existing OWNER via PATCH", async () => {
    mockOrgMemberFindFirst
      .mockResolvedValueOnce({ role: "ADMIN" }) // guard: caller is ADMIN
      .mockResolvedValueOnce({ id: "m-1", role: "OWNER", user: { role: "USER" } }); // target is OWNER
    const res = await patchMemberRoute(makeRequest("PATCH", memberDetailUrl(), { body: { role: "ADMIN" } }), { params: Promise.resolve({ orgId: ORG_ID, userId: TARGET_USER_ID }) });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/only org owners or platform superadmins can modify or remove/i);
  });

  it("ADMIN cannot delete an existing OWNER", async () => {
    mockOrgMemberFindFirst
      .mockResolvedValueOnce({ role: "ADMIN" }) // guard: caller is ADMIN
      .mockResolvedValueOnce({ role: "OWNER", user: { role: "USER" } }); // target is OWNER
    const res = await deleteMemberRoute(makeRequest("DELETE", memberDetailUrl()), { params: Promise.resolve({ orgId: ORG_ID, userId: TARGET_USER_ID }) });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/only org owners or platform superadmins can modify or remove/i);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation: OWNER of org-2 cannot access org-1
// ---------------------------------------------------------------------------

describe("tenant isolation: cross-org access denied", () => {
  it("OWNER of org-2 cannot list org-1 members", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-org2-owner", role: "USER" });
    // findFirst for org-1 returns null (they're not a member of org-1)
    mockOrgMemberFindFirst.mockResolvedValue(null);
    const res = await getMembersRoute(makeRequest("GET", membersListUrl()), { params: Promise.resolve({ orgId: ORG_ID }) });
    expect(res.status).toBe(403);
  });

  it("OWNER of org-2 cannot read org-1 audit log", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "user-org2-owner", role: "USER" });
    mockOrgMemberFindFirst.mockResolvedValue(null);
    const res = await getAuditRoute(makeRequest("GET", auditUrl()), { params: Promise.resolve({ orgId: ORG_ID }) });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// SUPERADMIN: can access any org, and email is included in member list
// ---------------------------------------------------------------------------

describe("SUPERADMIN: full access + email in member list", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockResolvedValue({ userId: "superadmin", role: "SUPERADMIN" });
    mockIsCurrentPlatformSuperadmin.mockResolvedValue(true);
  });

  it("SUPERADMIN can list members of any org", async () => {
    mockOrgMemberFindMany.mockResolvedValue([fakeMembership("MEMBER")]);
    const res = await getMembersRoute(makeRequest("GET", membersListUrl()), { params: Promise.resolve({ orgId: ORG_ID }) });
    expect(res.status).toBe(200);
  });

  it("SUPERADMIN member list includes email", async () => {
    mockOrgMemberFindMany.mockResolvedValue([fakeMembership("MEMBER")]);
    const res = await getMembersRoute(makeRequest("GET", membersListUrl()), { params: Promise.resolve({ orgId: ORG_ID }) });
    const body = await res.json() as { members: Array<Record<string, unknown>> };
    expect(body.members[0]).toHaveProperty("email");
  });

  it("SUPERADMIN can grant OWNER role", async () => {
    mockOrgFindUnique.mockResolvedValue({ id: ORG_ID });
    mockUserFindFirst.mockResolvedValue({ id: TARGET_USER_ID, email: "t@x.com", username: "t", displayName: null, role: "USER" });
    mockOrgMemberCreate.mockResolvedValue(fakeMembership("OWNER"));
    const res = await postMembersRoute(makeRequest("POST", membersListUrl(), { body: { email: "t@x.com", role: "OWNER" } }), { params: Promise.resolve({ orgId: ORG_ID }) });
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Bearer auth: no-cookie calls work for reads (proxy pattern)
// ---------------------------------------------------------------------------

describe("Bearer auth: Nexus proxy pattern", () => {
  it("GET /members via Bearer (no cookie) succeeds for OWNER", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: OWNER_USER_ID, role: "USER" });
    mockOrgMemberFindFirst.mockResolvedValue({ role: "OWNER" });
    mockOrgMemberFindMany.mockResolvedValue([]);
    const req = makeRequest("GET", membersListUrl(), { bearer: true, cookie: false });
    const res = await getMembersRoute(req, { params: Promise.resolve({ orgId: ORG_ID }) });
    expect(res.status).toBe(200);
  });

  it("POST /members via Bearer (no cookie) succeeds for OWNER (mutation bypasses CSRF because no cookie)", async () => {
    mockAuthenticateRequest.mockResolvedValue({ userId: OWNER_USER_ID, role: "USER" });
    // guard returns OWNER membership
    mockOrgMemberFindFirst.mockResolvedValue({ role: "OWNER" });
    mockOrgFindUnique.mockResolvedValue({ id: ORG_ID });
    mockUserFindFirst.mockResolvedValue({ id: TARGET_USER_ID, email: "t@x.com", username: "t", displayName: null, role: "USER" });
    mockOrgMemberCreate.mockResolvedValue(fakeMembership("MEMBER"));
    const req = makeRequest("POST", membersListUrl(), { bearer: true, cookie: false, body: { email: "t@x.com", role: "MEMBER" } });
    const res = await postMembersRoute(req, { params: Promise.resolve({ orgId: ORG_ID }) });
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Invariant: last manager cannot be demoted or removed
// ---------------------------------------------------------------------------

describe("last-manager invariant", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockResolvedValue({ userId: OWNER_USER_ID, role: "USER" });
    mockIsCurrentPlatformSuperadmin.mockResolvedValue(true);
  });

  it("cannot demote the last OWNER to MEMBER", async () => {
    mockOrgMemberFindFirst.mockResolvedValue({ id: "m-1", role: "OWNER", user: { role: "USER" } });
    mockOrgMemberCount.mockResolvedValue(1);
    const res = await patchMemberRoute(makeRequest("PATCH", memberDetailUrl(), { body: { role: "MEMBER" } }), { params: Promise.resolve({ orgId: ORG_ID, userId: TARGET_USER_ID }) });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/at least one owner or admin/);
  });

  it("cannot remove the last ADMIN", async () => {
    mockOrgMemberFindFirst.mockResolvedValue({ role: "ADMIN", user: { role: "USER" } });
    mockOrgMemberCount.mockResolvedValue(1);
    const res = await deleteMemberRoute(makeRequest("DELETE", memberDetailUrl()), { params: Promise.resolve({ orgId: ORG_ID, userId: TARGET_USER_ID }) });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Last-owner invariant: OWNER count must stay ≥ 1
// ---------------------------------------------------------------------------

describe("last-owner invariant", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockResolvedValue({ userId: OWNER_USER_ID, role: "USER" });
    // isCurrentPlatformSuperadmin is not mocked here → returns undefined (falsy) → OWNER path
  });

  it("cannot demote the last OWNER to MEMBER even when other managers remain", async () => {
    mockOrgMemberFindFirst
      .mockResolvedValueOnce({ role: "OWNER" }) // guard: caller is OWNER
      .mockResolvedValueOnce({ id: "m-1", role: "OWNER", user: { role: "USER" } }); // target is OWNER
    mockOrgMemberCount
      .mockResolvedValueOnce(2)   // managerCount (OWNER + 1 ADMIN) — passes "≥1 manager" check
      .mockResolvedValueOnce(1);  // ownerCount — blocked: only 1 OWNER
    const res = await patchMemberRoute(makeRequest("PATCH", memberDetailUrl(), { body: { role: "MEMBER" } }), { params: Promise.resolve({ orgId: ORG_ID, userId: TARGET_USER_ID }) });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/at least one owner/);
  });

  it("cannot demote last OWNER to ADMIN (would strip all OWNER roles)", async () => {
    mockOrgMemberFindFirst
      .mockResolvedValueOnce({ role: "OWNER" }) // guard
      .mockResolvedValueOnce({ id: "m-1", role: "OWNER", user: { role: "USER" } }); // target
    mockOrgMemberCount.mockResolvedValue(1); // ownerCount = 1 → blocked (manager count not checked for OWNER→ADMIN)
    const res = await patchMemberRoute(makeRequest("PATCH", memberDetailUrl(), { body: { role: "ADMIN" } }), { params: Promise.resolve({ orgId: ORG_ID, userId: TARGET_USER_ID }) });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/at least one owner/);
  });

  it("cannot delete the last OWNER even when other managers remain", async () => {
    mockOrgMemberFindFirst
      .mockResolvedValueOnce({ role: "OWNER" }) // guard: caller is OWNER
      .mockResolvedValueOnce({ role: "OWNER", user: { role: "USER" } }); // target is OWNER
    mockOrgMemberCount
      .mockResolvedValueOnce(2)   // managerCount — passes
      .mockResolvedValueOnce(1);  // ownerCount — blocked
    const res = await deleteMemberRoute(makeRequest("DELETE", memberDetailUrl()), { params: Promise.resolve({ orgId: ORG_ID, userId: TARGET_USER_ID }) });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/at least one owner/);
  });
});

// ---------------------------------------------------------------------------
// Invite revocation
// ---------------------------------------------------------------------------

describe("invite revocation", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockResolvedValue({ userId: OWNER_USER_ID, role: "USER" });
    mockOrgMemberFindFirst.mockResolvedValue({ role: "OWNER" });
  });

  it("cannot revoke an already-accepted invite", async () => {
    mockOrgInviteFindFirst.mockResolvedValue(fakeInvite({ acceptedAt: new Date() }));
    const res = await deleteInviteRoute(makeRequest("DELETE", inviteDetailUrl()), { params: Promise.resolve({ orgId: ORG_ID, inviteId: "invite-1" }) });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/already-accepted/);
  });

  it("cannot revoke an already-revoked invite", async () => {
    mockOrgInviteFindFirst.mockResolvedValue(fakeInvite({ revokedAt: new Date() }));
    const res = await deleteInviteRoute(makeRequest("DELETE", inviteDetailUrl()), { params: Promise.resolve({ orgId: ORG_ID, inviteId: "invite-1" }) });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/already been revoked/);
  });

  it("sets revokedAt on a pending invite", async () => {
    mockOrgInviteFindFirst.mockResolvedValue(fakeInvite());
    mockOrgInviteUpdate.mockResolvedValue({});
    const res = await deleteInviteRoute(makeRequest("DELETE", inviteDetailUrl()), { params: Promise.resolve({ orgId: ORG_ID, inviteId: "invite-1" }) });
    expect(res.status).toBe(200);
    expect(mockOrgInviteUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ revokedAt: expect.any(Date) }) }));
  });

  it("records org.invite.revoke audit event", async () => {
    mockOrgInviteFindFirst.mockResolvedValue(fakeInvite());
    mockOrgInviteUpdate.mockResolvedValue({});
    await deleteInviteRoute(makeRequest("DELETE", inviteDetailUrl()), { params: Promise.resolve({ orgId: ORG_ID, inviteId: "invite-1" }) });
    expect(mockRecordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "org.invite.revoke" }));
  });
});

// ---------------------------------------------------------------------------
// Audit log: cursor-based pagination
// ---------------------------------------------------------------------------

describe("GET /audit: pagination", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockResolvedValue({ userId: OWNER_USER_ID, role: "USER" });
    mockOrgMemberFindFirst.mockResolvedValue({ role: "OWNER" });
  });

  it("returns nextCursor when there are more rows", async () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({
      id: `ev-${i}`,
      createdAt: new Date(),
      action: "org.member.add",
      outcome: "success",
      actorUserId: OWNER_USER_ID,
      actorType: "user",
      targetType: "user",
      targetId: TARGET_USER_ID,
      metadata: {},
    }));
    mockAuditLogFindMany.mockResolvedValue(rows);
    const res = await getAuditRoute(makeRequest("GET", auditUrl()), { params: Promise.resolve({ orgId: ORG_ID }) });
    const body = await res.json() as { events: unknown[]; nextCursor: string | null };
    expect(body.events).toHaveLength(50);
    expect(body.nextCursor).toBe("ev-49");
  });

  it("returns null nextCursor on the last page", async () => {
    mockAuditLogFindMany.mockResolvedValue([{ id: "ev-1", createdAt: new Date(), action: "org.member.add", outcome: "success", actorUserId: OWNER_USER_ID, actorType: "user", targetType: "user", targetId: TARGET_USER_ID, metadata: {} }]);
    const res = await getAuditRoute(makeRequest("GET", auditUrl()), { params: Promise.resolve({ orgId: ORG_ID }) });
    const body = await res.json() as { nextCursor: string | null };
    expect(body.nextCursor).toBeNull();
  });
});
