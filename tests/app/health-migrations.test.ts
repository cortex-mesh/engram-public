import { describe, it, expect, vi, beforeEach } from "vitest";

// Route smoke tests: verify GET wires the DB query → computeMigrationStatus →
// JSON. The drift-comparison logic itself is covered exhaustively (incl. the
// DB-behind / DB-ahead / empty cases) in tests/lib/migration-status.test.ts.
const { queryRaw } = vi.hoisted(() => ({ queryRaw: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prismaUnscoped: { $queryRaw: queryRaw },
  prisma: {},
}));
vi.mock("@/lib/migrations-manifest", () => ({
  MIGRATIONS_MANIFEST: ["0001_a", "0002_b", "0003_c"],
}));

import { GET } from "@/app/api/health/migrations/route";

describe("GET /api/health/migrations (ADR-032)", () => {
  beforeEach(() => queryRaw.mockReset());

  it("returns 200 + upToDate when the DB has every manifest migration", async () => {
    queryRaw.mockResolvedValue(
      ["0001_a", "0002_b", "0003_c"].map((migration_name) => ({ migration_name })),
    );
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.upToDate).toBe(true);
    expect(body.pending).toEqual([]);
    expect(body.appliedThrough).toBe("0003_c");
  });

  it("returns 200 + drift + pending when the DB is behind the build", async () => {
    queryRaw.mockResolvedValue([{ migration_name: "0001_a" }]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("drift");
    expect(body.upToDate).toBe(false);
    expect(body.pending).toEqual(["0002_b", "0003_c"]);
  });
});
