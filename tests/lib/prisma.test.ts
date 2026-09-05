import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockBuildOrgExtension,
  mockBuildPgPoolConfig,
  mockPrismaClient,
  mockPrismaPg,
} = vi.hoisted(() => ({
  mockBuildOrgExtension: vi.fn((client) => ({ scopedClient: client })),
  mockBuildPgPoolConfig: vi.fn(() => ({
    connectionString: "postgresql://engram:secret@proxy.example:5432/engram",
    ssl: { rejectUnauthorized: false },
  })),
  mockPrismaClient: vi.fn(function PrismaClient(this: { marker: string }) {
    this.marker = "base-prisma";
  }),
  mockPrismaPg: vi.fn(function PrismaPg(_config) {
    return { adapterConfig: _config };
  }),
}));

vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: mockPrismaPg,
}));

vi.mock("@/generated/prisma/client", () => ({
  PrismaClient: mockPrismaClient,
}));

vi.mock("@/lib/prisma-config", () => ({
  buildPgPoolConfig: mockBuildPgPoolConfig,
}));

vi.mock("@/lib/prisma-org-extension", () => ({
  buildOrgExtension: mockBuildOrgExtension,
}));

describe("prisma client construction", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete (globalThis as { basePrisma?: unknown }).basePrisma;
  });

  it("passes pg config directly to PrismaPg instead of a Pool instance", async () => {
    const poolConfig = {
      connectionString: "postgresql://engram:secret@proxy.example:5432/engram",
      ssl: { rejectUnauthorized: false },
    };
    mockBuildPgPoolConfig.mockReturnValue(poolConfig);

    const prismaModule = await import("@/lib/prisma");

    expect(mockPrismaPg).toHaveBeenCalledWith(poolConfig);
    expect(mockPrismaPg.mock.calls[0]?.[0]).toHaveProperty("connectionString");
    expect(mockPrismaPg.mock.calls[0]?.[0]).not.toHaveProperty("connect");
    expect(mockPrismaClient).toHaveBeenCalledWith({
      adapter: { adapterConfig: poolConfig },
    });
    expect(prismaModule.prisma).toEqual({
      scopedClient: expect.objectContaining({ marker: "base-prisma" }),
    });
  });
});
