import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockEmailSuppressionFindMany,
  mockOrgFindMany,
  mockOrgFindUnique,
  mockUserFindMany,
  mockWaitlistFindMany,
} = vi.hoisted(() => ({
  mockEmailSuppressionFindMany: vi.fn(),
  mockOrgFindMany: vi.fn(),
  mockOrgFindUnique: vi.fn(),
  mockUserFindMany: vi.fn(),
  mockWaitlistFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    organization: {
      findMany: mockOrgFindMany,
      findUnique: mockOrgFindUnique,
    },
    user: {
      findMany: mockUserFindMany,
    },
    waitlistRequest: {
      findMany: mockWaitlistFindMany,
    },
    emailSuppression: {
      findMany: mockEmailSuppressionFindMany,
    },
  },
}));

import { getAdminClientDetail, getAdminOverview, listAdminApps, listAdminFeatures, listAdminUsers, listAdminWaitlistRequestPage } from "@/lib/admin-console";

describe("admin console data loaders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEmailSuppressionFindMany.mockResolvedValue([]);
  });

  it("loads the default waitlist page from visible rows only with pending rows first and a next cursor", async () => {
    const rows = Array.from({ length: 201 }, (_, index) => ({
      id: `wait-${index}`,
      email: `person-${index}@example.test`,
      displayName: null,
      clientId: index % 2 === 0 ? "tradepost-web" : null,
      collectionSizeBracket: null,
      formatsPlayed: [],
      tradepostGoals: [],
      priorityNote: null,
      requestCount: 1,
      lastRequestedAt: new Date("2026-07-14T12:00:00.000Z"),
      emailHygieneStatus: "accepted",
      emailHygieneReason: null,
      confirmationEmailSuppressedAt: null,
      approvedAt: index < 150 ? null : new Date("2026-07-15T12:00:00.000Z"),
      hiddenAt: null,
      hiddenByUserId: null,
      hiddenReason: null,
      createdAt: new Date(`2026-07-14T12:${String(index % 60).padStart(2, "0")}:00.000Z`),
    }));
    mockWaitlistFindMany.mockResolvedValue(rows);

    const page = await listAdminWaitlistRequestPage();

    expect(mockWaitlistFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { hiddenAt: null },
      orderBy: [
        { approvedAt: { sort: "asc", nulls: "first" } },
        { createdAt: "asc" },
        { id: "asc" },
      ],
      take: 201,
    }));
    expect(page.requests).toHaveLength(200);
    expect(page.nextCursor).toBe("wait-199");
    expect(page.requests.slice(0, 150).every((request) => request.approvedAt === null)).toBe(true);
  });

  it("pages hidden waitlist rows behind the explicit hidden visibility", async () => {
    mockWaitlistFindMany.mockResolvedValue([]);

    await listAdminWaitlistRequestPage({ visibility: "hidden", cursor: "wait-200", pageSize: 50 });

    expect(mockWaitlistFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { hiddenAt: { not: null } },
      cursor: { id: "wait-200" },
      skip: 1,
      take: 51,
    }));
  });

  it("summarizes hosted overview counts from users and organizations while excluding platform superadmin memberships", async () => {
    mockOrgFindMany.mockResolvedValue([
      {
        id: "org-1",
        name: "CORTEX",
        slug: "cortex",
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-21T00:00:00.000Z"),
        appEntitlements: [
          { appKey: "dashboard", enabled: true },
          { appKey: "thoughts", enabled: true },
        ],
        featureEntitlements: [{ appKey: "thoughts", featureKey: "projects", enabled: true }],
        members: [
          { userId: "user-1", user: { role: "SUPERADMIN" } },
          { userId: "user-2", user: { role: "USER" } },
        ],
      },
      {
        id: "org-2",
        name: "DBest",
        slug: "dbest",
        createdAt: new Date("2026-04-19T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
        appEntitlements: [{ appKey: "synapse", enabled: true }],
        featureEntitlements: [],
        members: [{ userId: "user-3", user: { role: "USER" } }],
      },
    ]);
    mockUserFindMany.mockResolvedValue([
      { id: "user-1", role: "SUPERADMIN" },
      { id: "user-2", role: "USER" },
      { id: "user-3", role: "USER" },
      { id: "user-4", role: "USER" },
    ]);

    const overview = await getAdminOverview();

    expect(overview.stats).toEqual({
      clientCount: 2,
      userCount: 3,
      membershipCount: 2,
      enabledAppCount: 3,
      enabledFeatureCount: 1,
    });
    expect(overview.recentClients.map((client) => ({ slug: client.slug, memberCount: client.memberCount }))).toEqual([
      { slug: "cortex", memberCount: 1 },
      { slug: "dbest", memberCount: 1 },
    ]);
  });

  it("surfaces email hygiene and provider suppressions in the waitlist queue", async () => {
    mockWaitlistFindMany.mockResolvedValue([
      {
        id: "wait-1",
        email: "bad@example.com",
        displayName: "Bad",
        clientId: "tradepost-web",
        collectionSizeBracket: null,
        formatsPlayed: [],
        tradepostGoals: [],
        priorityNote: null,
        requestCount: 1,
        lastRequestedAt: new Date("2026-07-14T00:30:00.000Z"),
        emailHygieneStatus: "accepted",
        emailHygieneReason: null,
        confirmationEmailSuppressedAt: null,
        approvedAt: null,
        hiddenAt: null,
        hiddenByUserId: null,
        hiddenReason: null,
        createdAt: new Date("2026-07-14T00:00:00.000Z"),
      },
    ]);
    mockEmailSuppressionFindMany.mockResolvedValue([
      {
        email: "bad@example.com",
        reason: "bounced",
        eventType: "email.bounced",
        updatedAt: new Date("2026-07-14T01:00:00.000Z"),
      },
    ]);

    await expect(listAdminWaitlistRequestPage()).resolves.toEqual(expect.objectContaining({
      requests: [
        expect.objectContaining({
          id: "wait-1",
          email: "bad@example.com",
          suppression: {
            reason: "bounced",
            eventType: "email.bounced",
            updatedAt: "2026-07-14T01:00:00.000Z",
          },
        }),
      ],
    }));
  });

  it("hydrates client detail with all app and feature catalog entries while hiding platform superadmins from org membership lists", async () => {
    mockOrgFindUnique.mockResolvedValue({
      id: "org-1",
      name: "CORTEX",
      slug: "cortex",
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-21T00:00:00.000Z"),
      appEntitlements: [{ appKey: "thoughts", enabled: true }],
      featureEntitlements: [{ appKey: "thoughts", featureKey: "adr", enabled: true }],
      members: [
        {
          role: "MEMBER",
          createdAt: new Date("2026-04-21T01:00:00.000Z"),
          user: {
            id: "user-2",
            email: "member@example.com",
            username: "member",
            displayName: "Member User",
            role: "USER",
          },
        },
        {
          role: "OWNER",
          createdAt: new Date("2026-04-20T01:00:00.000Z"),
          user: {
            id: "user-1",
            email: "owner@example.com",
            username: "owner",
            displayName: "Owner User",
            role: "SUPERADMIN",
          },
        },
      ],
    });

    const detail = await getAdminClientDetail("org-1");

    expect(detail?.members.map((member) => member.email)).toEqual(["member@example.com"]);
    expect(detail?.apps.map((app) => ({ key: app.key, enabled: app.enabled }))).toEqual([
      { key: "dashboard", enabled: false },
      { key: "synapse", enabled: false },
      { key: "thoughts", enabled: true },
      { key: "axon", enabled: false },
      { key: "pulse", enabled: false },
      { key: "gyrus", enabled: false },
    ]);
    expect(detail?.features).toEqual([
      {
        appKey: "thoughts",
        appName: "Thoughts",
        featureKey: "adr",
        featureName: "ADRs",
        description: "Architecture decision record workflows in Thoughts.",
        appEnabled: true,
        enabled: true,
      },
      {
        appKey: "thoughts",
        appName: "Thoughts",
        featureKey: "projects",
        featureName: "Projects",
        description: "Project and kanban workflows in Thoughts.",
        appEnabled: true,
        enabled: false,
      },
    ]);
  });

  it("surfaces each app's ADR-030 access mode, defaulting to ALL_MEMBERS when no entitlement row exists", async () => {
    mockOrgFindUnique.mockResolvedValue({
      id: "org-1",
      name: "CORTEX",
      slug: "cortex",
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-21T00:00:00.000Z"),
      appEntitlements: [
        { appKey: "thoughts", enabled: true, accessMode: "ALL_MEMBERS" },
        { appKey: "gyrus", enabled: true, accessMode: "RESTRICTED" },
      ],
      featureEntitlements: [],
      members: [],
    });

    const detail = await getAdminClientDetail("org-1");

    expect(detail?.apps.map((app) => ({ key: app.key, accessMode: app.accessMode }))).toEqual([
      { key: "dashboard", accessMode: "ALL_MEMBERS" },
      { key: "synapse", accessMode: "ALL_MEMBERS" },
      { key: "thoughts", accessMode: "ALL_MEMBERS" },
      { key: "axon", accessMode: "ALL_MEMBERS" },
      { key: "pulse", accessMode: "ALL_MEMBERS" },
      { key: "gyrus", accessMode: "RESTRICTED" },
    ]);
  });

  it("hides legacy org memberships from platform superadmins in the global users view", async () => {
    mockUserFindMany.mockResolvedValue([
      {
        id: "user-1",
        email: "admin@ctxhost.com",
        username: "ctxhost-admin",
        displayName: "CTXHost Admin",
        role: "SUPERADMIN",
        orgMembers: [
          {
            role: "OWNER",
            org: {
              id: "org-1",
              name: "CORTEX",
              slug: "cortex",
            },
          },
        ],
      },
      {
        id: "user-2",
        email: "member@example.com",
        username: "member",
        displayName: "Member User",
        role: "USER",
        orgMembers: [
          {
            role: "MEMBER",
            org: {
              id: "org-1",
              name: "CORTEX",
              slug: "cortex",
            },
          },
        ],
      },
    ]);

    const users = await listAdminUsers();

    expect(users).toEqual([
      {
        id: "user-1",
        email: "admin@ctxhost.com",
        username: "ctxhost-admin",
        displayName: "CTXHost Admin",
        role: "SUPERADMIN",
        organizations: [],
      },
      {
        id: "user-2",
        email: "member@example.com",
        username: "member",
        displayName: "Member User",
        role: "USER",
        organizations: [
          {
            id: "org-1",
            name: "CORTEX",
            slug: "cortex",
            role: "MEMBER",
          },
        ],
      },
    ]);
  });

  it("summarizes app and feature usage across organizations", async () => {
    mockOrgFindMany.mockResolvedValue([
      {
        id: "org-1",
        name: "CORTEX",
        slug: "cortex",
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-21T00:00:00.000Z"),
        appEntitlements: [
          { appKey: "dashboard", enabled: true },
          { appKey: "thoughts", enabled: true },
        ],
        featureEntitlements: [
          { appKey: "thoughts", featureKey: "projects", enabled: true },
          { appKey: "thoughts", featureKey: "adr", enabled: false },
        ],
        members: [],
      },
      {
        id: "org-2",
        name: "DBest",
        slug: "dbest",
        createdAt: new Date("2026-04-19T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
        appEntitlements: [{ appKey: "pulse", enabled: true }],
        featureEntitlements: [],
        members: [],
      },
      {
        id: "org-3",
        name: "Disabled Thoughts",
        slug: "disabled-thoughts",
        createdAt: new Date("2026-04-18T00:00:00.000Z"),
        updatedAt: new Date("2026-04-19T00:00:00.000Z"),
        appEntitlements: [{ appKey: "thoughts", enabled: false }],
        featureEntitlements: [{ appKey: "thoughts", featureKey: "projects", enabled: true }],
        members: [],
      },
    ]);

    const apps = await listAdminApps();
    const features = await listAdminFeatures();

    expect(apps.map((app) => ({ key: app.key, enabledClientCount: app.enabledClientCount }))).toEqual([
      { key: "dashboard", enabledClientCount: 1 },
      { key: "synapse", enabledClientCount: 0 },
      { key: "thoughts", enabledClientCount: 1 },
      { key: "axon", enabledClientCount: 0 },
      { key: "pulse", enabledClientCount: 1 },
      { key: "gyrus", enabledClientCount: 0 },
    ]);
    expect(features).toEqual([
      {
        appKey: "thoughts",
        appName: "Thoughts",
        featureKey: "adr",
        featureName: "ADRs",
        description: "Architecture decision record workflows in Thoughts.",
        enabledClientCount: 0,
      },
      {
        appKey: "thoughts",
        appName: "Thoughts",
        featureKey: "projects",
        featureName: "Projects",
        description: "Project and kanban workflows in Thoughts.",
        enabledClientCount: 1,
      },
    ]);
  });
});
