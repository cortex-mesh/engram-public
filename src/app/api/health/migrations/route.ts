import { NextResponse } from "next/server";
import { prismaUnscoped } from "@/lib/prisma";
import { MIGRATIONS_MANIFEST } from "@/lib/migrations-manifest";
import { computeMigrationStatus } from "@/lib/migration-status";

// Never cached — this must reflect the live DB state each call (ADR-032).
export const dynamic = "force-dynamic";

/**
 * Migration drift check (ADR-032). Compares the migrations bundled in this
 * build (MIGRATIONS_MANIFEST, generated at build time) against the migrations
 * actually applied to the connected DB (`_prisma_migrations`). Used by the
 * prod deploy gate and a scheduled drift monitor — the running app is the only
 * thing that can see the private prod RDS. Exposes migration names/counts only
 * (they live in git); no row data, no secrets. Unauthenticated like
 * /api/health so the deploy runner can read it without DB access or creds.
 */
export async function GET() {
  try {
    // Match what `prisma migrate deploy` treats as applied: finished AND not
    // rolled back (a rolled-back migration will be re-applied, so it is NOT
    // applied for drift purposes).
    const rows = (await prismaUnscoped.$queryRaw`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    `) as Array<{ migration_name: string }>;
    const status = computeMigrationStatus(
      rows.map((r) => r.migration_name),
      MIGRATIONS_MANIFEST,
    );
    // A drift is a real, reportable state (not a request failure) → 200 so
    // monitors read the body; the deploy gate keys off `upToDate`/`pending`.
    return NextResponse.json(status, { status: 200 });
  } catch {
    return NextResponse.json(
      {
        status: "error",
        upToDate: null,
        error: "migration status unavailable (database unreachable)",
      },
      { status: 503 },
    );
  }
}
