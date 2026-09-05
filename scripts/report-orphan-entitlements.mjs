#!/usr/bin/env node
//
// Report (and optionally delete) orphan UserAppEntitlement rows — per-user
// app-entitlement overrides scoped to an org for a user who is NOT a member
// of that org. Before the HG-1 fix (security audit 2026-06-10), an org
// owner/admin could create such rows for arbitrary users, breaking tenant
// isolation. This finds the residue.
//
//   DATABASE_URL=postgres://... node scripts/report-orphan-entitlements.mjs
//   DATABASE_URL=postgres://... node scripts/report-orphan-entitlements.mjs --delete
//
// Read-only by default. Run the report on each environment and review the
// rows before passing --delete. (Run against on-prem + aws-dev only; never
// aws-prod ad hoc.)

import process from "node:process";

import pg from "pg";

const { Pool } = pg;

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
  return value.trim();
}

function pgPoolConfig(databaseUrl) {
  const url = new URL(databaseUrl);
  const sslMode = url.searchParams.get("sslmode");
  if (!sslMode || sslMode === "disable") {
    return { connectionString: databaseUrl };
  }
  url.searchParams.delete("sslmode");
  return {
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: false },
  };
}

const ORPHAN_SQL = `
  SELECT e.id, e."userId", e."orgId", e."appKey", e.enabled,
         e."createdByUserId", e."createdAt"
  FROM "UserAppEntitlement" e
  LEFT JOIN "OrgMember" m
    ON m."userId" = e."userId" AND m."orgId" = e."orgId"
  WHERE m.id IS NULL
  ORDER BY e."orgId", e."userId", e."appKey"
`;

async function main() {
  const apply = process.argv.includes("--delete");
  const pool = new Pool(pgPoolConfig(requireEnv("DATABASE_URL")));

  try {
    const { rows } = await pool.query(ORPHAN_SQL);

    if (rows.length === 0) {
      console.log("No orphan UserAppEntitlement rows found. ✓");
      return;
    }

    console.log(
      `Found ${rows.length} orphan UserAppEntitlement row(s) (no matching OrgMember):\n`,
    );
    for (const r of rows) {
      const at = r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt;
      console.log(
        `  ${r.id}  org=${r.orgId}  user=${r.userId}  app=${r.appKey}  ` +
          `enabled=${r.enabled}  createdBy=${r.createdByUserId ?? "?"}  at=${at}`,
      );
    }

    if (!apply) {
      console.log("\nReport only. Re-run with --delete to remove these rows.");
      return;
    }

    const ids = rows.map((r) => r.id);
    const res = await pool.query(
      `DELETE FROM "UserAppEntitlement" WHERE id = ANY($1::text[])`,
      [ids],
    );
    console.log(`\nDeleted ${res.rowCount} orphan row(s).`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
