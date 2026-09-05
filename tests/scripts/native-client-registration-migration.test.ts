import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = join(
  process.cwd(),
  "prisma/migrations/0009_register_synapse_native_client/migration.sql",
);

describe("Synapse native client registration migration", () => {
  it("registers the Synapse native public client and callback URI idempotently", () => {
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toContain('"NativeAuthClient"');
    expect(migration).toContain('"NativeAuthRedirectUri"');
    expect(migration).toContain("synapse-native");
    expect(migration).toContain("Synapse Native");
    expect(migration).toContain("synapse://auth/engram/callback");
    expect(migration).toContain('ON CONFLICT ("clientId") DO UPDATE');
    expect(migration).toContain('ON CONFLICT ("clientId", "redirectUri") DO UPDATE');
  });
});
