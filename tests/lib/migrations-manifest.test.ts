import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  readMigrationNames,
  renderManifest,
} from "../../scripts/gen-migrations-manifest.mjs";
import { MIGRATIONS_MANIFEST } from "@/lib/migrations-manifest";

const root = join(__dirname, "..", "..");

// The manifest is a COMMITTED generated file (CI runs `npx prisma generate`
// with --ignore-scripts, so a build-time hook would not run). This test fails
// if someone adds a migration without running `npm run gen:migrations-manifest`,
// keeping the committed manifest honest. See ADR-032.
describe("migrations-manifest is current", () => {
  it("matches the migration directories on disk", () => {
    const onDisk = readMigrationNames(join(root, "prisma", "migrations"));
    expect([...MIGRATIONS_MANIFEST]).toEqual(onDisk);
  });

  it("the committed file matches the generator output", () => {
    const onDisk = readMigrationNames(join(root, "prisma", "migrations"));
    const committed = readFileSync(
      join(root, "src", "lib", "migrations-manifest.ts"),
      "utf8",
    );
    // Normalize CRLF → LF so a checkout under git core.autocrlf=true doesn't
    // fail on line endings alone (the content is what matters).
    const norm = (s: string) => s.replace(/\r\n/g, "\n");
    expect(norm(committed)).toBe(norm(renderManifest(onDisk)));
  });
});
