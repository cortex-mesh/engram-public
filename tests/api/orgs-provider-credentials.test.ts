import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// --- hoisted mocks -------------------------------------------------------

const {
  mockAuthenticateRequest,
  mockOrgMemberFindFirst,
  mockCredentialFindUnique,
  mockCredentialFindMany,
  mockCredentialUpsert,
  mockCredentialDelete,
  mockWriteProviderSecret,
  mockReadProviderSecret,
  mockDeleteProviderSecret,
  mockTestProviderKey,
  mockAuditRecord,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockOrgMemberFindFirst: vi.fn(),
  mockCredentialFindUnique: vi.fn(),
  mockCredentialFindMany: vi.fn(),
  mockCredentialUpsert: vi.fn(),
  mockCredentialDelete: vi.fn(),
  mockWriteProviderSecret: vi.fn(),
  mockReadProviderSecret: vi.fn(),
  mockDeleteProviderSecret: vi.fn(),
  mockTestProviderKey: vi.fn(),
  mockAuditRecord: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authenticateRequest: mockAuthenticateRequest,
  isCurrentPlatformSuperadmin: vi.fn(async (auth) => auth?.role === "SUPERADMIN"),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    orgMember: { findFirst: mockOrgMemberFindFirst },
    orgProviderCredential: {
      findUnique: mockCredentialFindUnique,
      findMany: mockCredentialFindMany,
      upsert: mockCredentialUpsert,
      delete: mockCredentialDelete,
    },
  },
}));

vi.mock("@/lib/asm-client", () => ({
  writeProviderSecret: mockWriteProviderSecret,
  readProviderSecret: mockReadProviderSecret,
  deleteProviderSecret: mockDeleteProviderSecret,
}));

vi.mock("@/lib/provider-credentials", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/provider-credentials")>();
  return { ...orig, testProviderKey: mockTestProviderKey };
});

vi.mock("@/lib/audit", () => ({ recordAuditEvent: mockAuditRecord }));

import { GET } from "@/app/api/orgs/[orgId]/provider-credentials/route";
import {
  PUT,
  DELETE,
} from "@/app/api/orgs/[orgId]/provider-credentials/[provider]/route";
import { POST as TEST } from "@/app/api/orgs/[orgId]/provider-credentials/[provider]/test/route";

// --- helpers -------------------------------------------------------------

function makeRequest(
  method: string,
  body?: Record<string, unknown>,
  useCookie = true,
) {
  return new NextRequest("https://login.dev.ctxhost.com/api/orgs/org-1/provider-credentials", {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(useCookie
        ? { Cookie: "engram-access=jwt-token", "Sec-Fetch-Site": "same-origin" }
        : { Authorization: "Bearer some-service-token" }),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const OWNER_AUTH = { userId: "user-owner", role: "USER" };
const OWNER_MEMBERSHIP = { role: "OWNER" };
const MEMBER_AUTH = { userId: "user-member", role: "USER" };
const MEMBER_MEMBERSHIP = { role: "MEMBER" };

const VALID_KEY = "sk-ant-api03-aaabbcccdddeeefff1234567890abcdef";

const STORED_ROW_FIELDS = {
  provider: "anthropic_api" as const,
  status: "active" as const,
  last4: "cdef",
  credentialKind: "aws_secrets_manager",
  rotatedAt: new Date("2026-06-14T00:00:00.000Z"),
  updatedAt: new Date("2026-06-14T00:00:00.000Z"),
};

// Upsert result when a NEW row is created: createdAt ≈ updatedAt (both set in
// the same DB write), so isNew detection triggers "set" audit action.
const NEW_UPSERT_RESULT = {
  ...STORED_ROW_FIELDS,
  last4: VALID_KEY.slice(-4),
  createdAt: new Date("2026-06-14T12:00:00.000Z"),
  updatedAt: new Date("2026-06-14T12:00:00.000Z"),
};

// Upsert result when an EXISTING row is updated: createdAt is older than updatedAt,
// so isNew detection triggers "rotate" audit action.
const UPDATED_UPSERT_RESULT = {
  ...STORED_ROW_FIELDS,
  createdAt: new Date("2026-06-01T00:00:00.000Z"), // older
  updatedAt: new Date("2026-06-14T12:00:00.000Z"),
};

// --- GET /provider-credentials -------------------------------------------

describe("GET /api/orgs/[orgId]/provider-credentials", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuthenticateRequest.mockResolvedValue(OWNER_AUTH);
    mockOrgMemberFindFirst.mockResolvedValue(OWNER_MEMBERSHIP);
  });

  it("returns an empty list when no credentials are set", async () => {
    mockCredentialFindMany.mockResolvedValue([]);
    const res = await GET(makeRequest("GET"), { params: Promise.resolve({ orgId: "org-1" }) });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ credentials: [] });
  });

  it("returns masked credential rows (no key plaintext)", async () => {
    mockCredentialFindMany.mockResolvedValue([STORED_ROW_FIELDS]);
    const res = await GET(makeRequest("GET"), { params: Promise.resolve({ orgId: "org-1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.credentials).toHaveLength(1);
    expect(body.credentials[0]).toMatchObject({ provider: "anthropic_api", last4: "cdef" });
    // credentialRef must never appear in the response
    expect(JSON.stringify(body.credentials)).not.toContain("credentialRef");
  });

  it("blocks org MEMBERs", async () => {
    mockAuthenticateRequest.mockResolvedValue(MEMBER_AUTH);
    mockOrgMemberFindFirst.mockResolvedValue(MEMBER_MEMBERSHIP);
    const res = await GET(makeRequest("GET"), { params: Promise.resolve({ orgId: "org-1" }) });
    expect(res.status).toBe(403);
  });

  it("blocks unauthenticated callers", async () => {
    mockAuthenticateRequest.mockResolvedValue(null);
    const res = await GET(makeRequest("GET"), { params: Promise.resolve({ orgId: "org-1" }) });
    expect(res.status).toBe(401);
  });
});

// --- PUT /provider-credentials/[provider] --------------------------------

describe("PUT /api/orgs/[orgId]/provider-credentials/[provider]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuthenticateRequest.mockResolvedValue(OWNER_AUTH);
    mockOrgMemberFindFirst.mockResolvedValue(OWNER_MEMBERSHIP);
    mockWriteProviderSecret.mockResolvedValue(undefined);
  });

  it("rejects an unknown provider", async () => {
    const res = await PUT(makeRequest("PUT", { apiKey: VALID_KEY }), {
      params: Promise.resolve({ orgId: "org-1", provider: "openai" }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: /Unknown provider/ });
  });

  it("rejects a too-short key", async () => {
    const res = await PUT(makeRequest("PUT", { apiKey: "short" }), {
      params: Promise.resolve({ orgId: "org-1", provider: "anthropic_api" }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: /too short/ });
  });

  it("blocks org MEMBERs (no ASM write)", async () => {
    mockAuthenticateRequest.mockResolvedValue(MEMBER_AUTH);
    mockOrgMemberFindFirst.mockResolvedValue(MEMBER_MEMBERSHIP);
    const res = await PUT(makeRequest("PUT", { apiKey: VALID_KEY }), {
      params: Promise.resolve({ orgId: "org-1", provider: "anthropic_api" }),
    });
    expect(res.status).toBe(403);
    expect(mockWriteProviderSecret).not.toHaveBeenCalled();
  });

  it("creates a new credential: DB upsert runs BEFORE ASM write, audits as 'set'", async () => {
    mockCredentialUpsert.mockResolvedValue(NEW_UPSERT_RESULT);
    const res = await PUT(makeRequest("PUT", { apiKey: VALID_KEY }), {
      params: Promise.resolve({ orgId: "org-1", provider: "anthropic_api" }),
    });
    expect(res.status).toBe(200);

    // DB upsert must have run before ASM write (verify via call order)
    const upsertOrder = mockCredentialUpsert.mock.invocationCallOrder[0];
    const asmOrder = mockWriteProviderSecret.mock.invocationCallOrder[0];
    expect(upsertOrder).toBeLessThan(asmOrder);

    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: "org.provider_credential.set", outcome: "success" }),
    );
    const body = await res.json();
    expect(body.credential).toMatchObject({ provider: "anthropic_api", last4: VALID_KEY.slice(-4) });
    // createdAt must not appear in the response (internal detection field)
    expect(JSON.stringify(body)).not.toContain("createdAt");
    // plaintext key must never appear
    expect(JSON.stringify(body)).not.toContain(VALID_KEY);
  });

  it("rotates an existing credential (createdAt older than updatedAt), audits as 'rotate'", async () => {
    mockCredentialUpsert.mockResolvedValue(UPDATED_UPSERT_RESULT);
    await PUT(makeRequest("PUT", { apiKey: VALID_KEY }), {
      params: Promise.resolve({ orgId: "org-1", provider: "anthropic_api" }),
    });
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: "org.provider_credential.rotate" }),
    );
  });

  it("stores only last4 in the DB upsert — never the plaintext key", async () => {
    mockCredentialUpsert.mockResolvedValue(NEW_UPSERT_RESULT);
    await PUT(makeRequest("PUT", { apiKey: VALID_KEY }), {
      params: Promise.resolve({ orgId: "org-1", provider: "anthropic_api" }),
    });
    const upsertCall = mockCredentialUpsert.mock.calls[0][0];
    const payloadStr = JSON.stringify(upsertCall);
    expect(payloadStr).not.toContain(VALID_KEY);
    expect(upsertCall.create.last4).toBe(VALID_KEY.slice(-4));
    expect(upsertCall.create).not.toHaveProperty("apiKey");
  });

  it("cross-org isolation: request for org-2 cannot affect org-1 credentials", async () => {
    mockOrgMemberFindFirst.mockImplementation(async ({ where }: { where: { orgId: string } }) => {
      if (where.orgId === "org-1") return null;
      return OWNER_MEMBERSHIP;
    });
    const res = await PUT(makeRequest("PUT", { apiKey: VALID_KEY }), {
      params: Promise.resolve({ orgId: "org-1", provider: "anthropic_api" }),
    });
    expect(res.status).toBe(403);
    expect(mockWriteProviderSecret).not.toHaveBeenCalled();
    expect(mockCredentialUpsert).not.toHaveBeenCalled();
  });
});

// --- DELETE /provider-credentials/[provider] -----------------------------

describe("DELETE /api/orgs/[orgId]/provider-credentials/[provider]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuthenticateRequest.mockResolvedValue(OWNER_AUTH);
    mockOrgMemberFindFirst.mockResolvedValue(OWNER_MEMBERSHIP);
    mockDeleteProviderSecret.mockResolvedValue(undefined);
    mockCredentialDelete.mockResolvedValue({});
  });

  it("returns 404 if no credential exists", async () => {
    mockCredentialFindUnique.mockResolvedValue(null);
    const res = await DELETE(makeRequest("DELETE"), {
      params: Promise.resolve({ orgId: "org-1", provider: "anthropic_api" }),
    });
    expect(res.status).toBe(404);
    expect(mockDeleteProviderSecret).not.toHaveBeenCalled();
    expect(mockCredentialDelete).not.toHaveBeenCalled();
  });

  it("deletes DB row BEFORE ASM secret, audits, returns success", async () => {
    mockCredentialFindUnique.mockResolvedValue({
      id: "cred-1",
      credentialRef: "cortex/dev/org/org-1/provider/anthropic_api",
    });
    const res = await DELETE(makeRequest("DELETE"), {
      params: Promise.resolve({ orgId: "org-1", provider: "anthropic_api" }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });

    // DB delete must precede ASM delete
    const dbDeleteOrder = mockCredentialDelete.mock.invocationCallOrder[0];
    const asmDeleteOrder = mockDeleteProviderSecret.mock.invocationCallOrder[0];
    expect(dbDeleteOrder).toBeLessThan(asmDeleteOrder);

    expect(mockDeleteProviderSecret).toHaveBeenCalledWith(
      "cortex/dev/org/org-1/provider/anthropic_api",
    );
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: "org.provider_credential.delete", outcome: "success" }),
    );
  });

  it("returns success and audits even if ASM delete throws (soft-fail)", async () => {
    mockCredentialFindUnique.mockResolvedValue({
      id: "cred-1",
      credentialRef: "cortex/dev/org/org-1/provider/anthropic_api",
    });
    mockDeleteProviderSecret.mockRejectedValue(new Error("ASM permission denied"));
    const res = await DELETE(makeRequest("DELETE"), {
      params: Promise.resolve({ orgId: "org-1", provider: "anthropic_api" }),
    });
    // DB row is already gone; success is returned and audit is recorded
    expect(res.status).toBe(200);
    expect(mockCredentialDelete).toHaveBeenCalled();
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: "org.provider_credential.delete", outcome: "success" }),
    );
  });

  it("blocks org MEMBERs", async () => {
    mockAuthenticateRequest.mockResolvedValue(MEMBER_AUTH);
    mockOrgMemberFindFirst.mockResolvedValue(MEMBER_MEMBERSHIP);
    const res = await DELETE(makeRequest("DELETE"), {
      params: Promise.resolve({ orgId: "org-1", provider: "anthropic_api" }),
    });
    expect(res.status).toBe(403);
  });
});

// --- POST /provider-credentials/[provider]/test --------------------------

describe("POST /api/orgs/[orgId]/provider-credentials/[provider]/test", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuthenticateRequest.mockResolvedValue(OWNER_AUTH);
    mockOrgMemberFindFirst.mockResolvedValue(OWNER_MEMBERSHIP);
    mockTestProviderKey.mockResolvedValue({ ok: true, detail: "Key accepted." });
  });

  it("tests a supplied key without reading from ASM", async () => {
    const res = await TEST(makeRequest("POST", { apiKey: VALID_KEY }), {
      params: Promise.resolve({ orgId: "org-1", provider: "anthropic_api" }),
    });
    expect(res.status).toBe(200);
    expect(mockReadProviderSecret).not.toHaveBeenCalled();
    expect(mockTestProviderKey).toHaveBeenCalledWith("anthropic_api", VALID_KEY);
    await expect(res.json()).resolves.toEqual({ ok: true, detail: "Key accepted." });
  });

  it("fetches the stored key from ASM when no key is supplied", async () => {
    mockCredentialFindUnique.mockResolvedValue({
      credentialRef: "cortex/dev/org/org-1/provider/anthropic_api",
    });
    mockReadProviderSecret.mockResolvedValue(VALID_KEY);
    const res = await TEST(makeRequest("POST"), {
      params: Promise.resolve({ orgId: "org-1", provider: "anthropic_api" }),
    });
    expect(res.status).toBe(200);
    expect(mockReadProviderSecret).toHaveBeenCalledWith(
      "cortex/dev/org/org-1/provider/anthropic_api",
    );
    expect(mockTestProviderKey).toHaveBeenCalledWith("anthropic_api", VALID_KEY);
  });

  it("returns 404 when testing stored key but none is configured", async () => {
    mockCredentialFindUnique.mockResolvedValue(null);
    const res = await TEST(makeRequest("POST"), {
      params: Promise.resolve({ orgId: "org-1", provider: "anthropic_api" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 503 when ASM read fails", async () => {
    mockCredentialFindUnique.mockResolvedValue({
      credentialRef: "cortex/dev/org/org-1/provider/anthropic_api",
    });
    mockReadProviderSecret.mockRejectedValue(new Error("ASM not configured"));
    const res = await TEST(makeRequest("POST"), {
      params: Promise.resolve({ orgId: "org-1", provider: "anthropic_api" }),
    });
    expect(res.status).toBe(503);
  });

  it("audits with outcome matching the provider test result", async () => {
    mockTestProviderKey.mockResolvedValue({ ok: false, detail: "Invalid key." });
    await TEST(makeRequest("POST", { apiKey: VALID_KEY }), {
      params: Promise.resolve({ orgId: "org-1", provider: "anthropic_api" }),
    });
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "org.provider_credential.test",
        outcome: "failure",
        metadata: expect.objectContaining({ ok: false, source: "supplied" }),
      }),
    );
  });

  it("blocks MEMBERs", async () => {
    mockAuthenticateRequest.mockResolvedValue(MEMBER_AUTH);
    mockOrgMemberFindFirst.mockResolvedValue(MEMBER_MEMBERSHIP);
    const res = await TEST(makeRequest("POST", { apiKey: VALID_KEY }), {
      params: Promise.resolve({ orgId: "org-1", provider: "anthropic_api" }),
    });
    expect(res.status).toBe(403);
    expect(mockTestProviderKey).not.toHaveBeenCalled();
  });

  it("rejects an unknown provider", async () => {
    const res = await TEST(makeRequest("POST", { apiKey: VALID_KEY }), {
      params: Promise.resolve({ orgId: "org-1", provider: "unknown_llm" }),
    });
    expect(res.status).toBe(400);
  });
});
