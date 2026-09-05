import { describe, it, expect } from "vitest";
import { computeMigrationStatus } from "@/lib/migration-status";

const MANIFEST = ["0001_a", "0002_b", "0003_c"] as const;

describe("computeMigrationStatus (ADR-032 drift comparison)", () => {
  it("is up-to-date when every manifest migration is applied", () => {
    const s = computeMigrationStatus(["0001_a", "0002_b", "0003_c"], MANIFEST);
    expect(s).toMatchObject({
      status: "ok",
      upToDate: true,
      pending: [],
      ahead: [],
      appliedThrough: "0003_c",
      expectedThrough: "0003_c",
      expectedCount: 3,
      appliedCount: 3,
    });
  });

  it("reports drift + the ordered pending list when the DB is behind", () => {
    // Exactly the 2026-07-22 case: DB at 0001, build expects through 0003.
    const s = computeMigrationStatus(["0001_a"], MANIFEST);
    expect(s.status).toBe("drift");
    expect(s.upToDate).toBe(false);
    expect(s.pending).toEqual(["0002_b", "0003_c"]);
    expect(s.appliedThrough).toBe("0001_a");
    expect(s.expectedThrough).toBe("0003_c");
  });

  it("flags DB-ahead (rolled-back deploy) via `ahead`", () => {
    const s = computeMigrationStatus(
      ["0001_a", "0002_b", "0003_c", "0004_future"],
      MANIFEST,
    );
    expect(s.upToDate).toBe(false);
    expect(s.pending).toEqual([]);
    expect(s.ahead).toEqual(["0004_future"]);
    // appliedThrough is the manifest high-water mark, not the unknown future one.
    expect(s.appliedThrough).toBe("0003_c");
    // dbLatestApplied is the DB's true max, independent of the manifest (used
    // by the deploy gate).
    expect(s.dbLatestApplied).toBe("0004_future");
  });

  it("handles an empty DB (nothing applied yet)", () => {
    const s = computeMigrationStatus([], MANIFEST);
    expect(s.upToDate).toBe(false);
    expect(s.pending).toEqual(["0001_a", "0002_b", "0003_c"]);
    expect(s.appliedThrough).toBeNull();
  });

  it("ignores applied order — set membership drives the result", () => {
    const s = computeMigrationStatus(["0003_c", "0001_a", "0002_b"], MANIFEST);
    expect(s.upToDate).toBe(true);
    expect(s.appliedThrough).toBe("0003_c");
  });

  it("exposes the sorted applied set (for the gap-safe deploy gate)", () => {
    const s = computeMigrationStatus(["0003_c", "0001_a"], MANIFEST);
    expect(s.applied).toEqual(["0001_a", "0003_c"]);
  });

  it("reports an out-of-order gap in `pending` (0002 missing though 0003 applied)", () => {
    const s = computeMigrationStatus(["0001_a", "0003_c"], MANIFEST);
    expect(s.pending).toEqual(["0002_b"]);
    expect(s.applied).toEqual(["0001_a", "0003_c"]);
    expect(s.dbLatestApplied).toBe("0003_c");
  });
});
