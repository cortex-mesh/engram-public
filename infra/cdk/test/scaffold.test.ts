import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

describe("infra/cdk scaffold", () => {
  it("contains the expected top-level files and directories", () => {
    expect(existsSync(join(ROOT, "package.json"))).toBe(true);
    expect(existsSync(join(ROOT, "tsconfig.json"))).toBe(true);
    expect(existsSync(join(ROOT, "cdk.json"))).toBe(true);
    expect(existsSync(join(ROOT, "bin", "engram-infra.ts"))).toBe(true);
    expect(existsSync(join(ROOT, "lib"))).toBe(true);
  });
});
