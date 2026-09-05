// Pure migration-drift comparison (ADR-032). Compares the migrations bundled in
// a build (the manifest) against the migrations applied to a DB, with no I/O —
// so it is trivially unit-testable. The route (/api/health/migrations) does the
// DB read and hands the results here.

export interface MigrationStatus {
  status: "ok" | "drift";
  upToDate: boolean;
  /** Last manifest migration (the schema this build expects). */
  expectedThrough: string | null;
  /** Last manifest migration that IS applied (the DB's high-water mark). */
  appliedThrough: string | null;
  /**
   * The DB's latest applied migration name, independent of this build's
   * manifest (lexical max — Prisma's zero-padded prefixes sort in applied
   * order). The prod deploy gate compares a checkout's migrations against this
   * to refuse shipping code ahead of schema (ADR-032).
   */
  dbLatestApplied: string | null;
  expectedCount: number;
  appliedCount: number;
  /** Manifest migrations not yet applied — DB is behind the code. */
  pending: string[];
  /** Applied migrations not in this build — DB is ahead (e.g. rolled-back deploy). */
  ahead: string[];
  /**
   * Every migration name applied to the DB, sorted. The deploy gate uses this
   * as the authoritative set to diff a checkout against (gap-safe — an
   * out-of-order missing migration is caught, unlike a max-name comparison).
   */
  applied: string[];
}

export function computeMigrationStatus(
  appliedNames: Iterable<string>,
  manifest: readonly string[],
): MigrationStatus {
  const applied = new Set(appliedNames);
  const pending = manifest.filter((m) => !applied.has(m));
  const appliedExpected = manifest.filter((m) => applied.has(m));
  const ahead = [...applied].filter((m) => !manifest.includes(m));
  const upToDate = pending.length === 0 && ahead.length === 0;
  const appliedSorted = [...applied].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const dbLatestApplied = appliedSorted[appliedSorted.length - 1] ?? null;
  return {
    status: upToDate ? "ok" : "drift",
    upToDate,
    expectedThrough: manifest[manifest.length - 1] ?? null,
    appliedThrough: appliedExpected[appliedExpected.length - 1] ?? null,
    dbLatestApplied,
    expectedCount: manifest.length,
    appliedCount: applied.size,
    pending,
    ahead,
    applied: appliedSorted,
  };
}
