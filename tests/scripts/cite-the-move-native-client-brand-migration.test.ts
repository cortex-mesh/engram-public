import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = join(
  process.cwd(),
  "prisma/migrations/0025_cite_the_move_engram_brand/migration.sql",
);
const registrationPath = join(
  process.cwd(),
  "prisma/migrations/0024_register_axon_native_client/migration.sql",
);

describe("Cite the Move native-client brand migration", () => {
  it("updates only axon-web presentation metadata while preserving its registration contract", () => {
    const migration = readFileSync(migrationPath, "utf8");
    const registration = readFileSync(registrationPath, "utf8");

    expect(migration).toContain('WHERE "clientId" = \'axon-web\'');
    expect(migration).toContain('"displayName" = \'Cite the Move\'');
    expect(migration).toContain('"brandName" = \'Cite the Move\'');
    expect(migration).toContain('"emailFromName" = \'Cite the Move\'');
    const setBlock = migration.split("WHERE")[0];
    expect(setBlock).not.toContain('"clientId"');
    expect(setBlock).not.toContain('"enabled"');
    expect(setBlock).not.toContain('"signupMode"');
    expect(migration).not.toContain('NativeAuthRedirectUri');

    expect(registration).toContain("'axon-web'");
    expect(registration).toContain("'https://axon.dev.ctxhost.com/auth/callback'");
    expect(registration).toContain("'http://localhost:3103/auth/callback'");
    expect(registration).toContain("'https://lab.rapidagent.dev:8443/axon/auth/callback'");
  });
});
