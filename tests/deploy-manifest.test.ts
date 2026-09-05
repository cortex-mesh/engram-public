import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const OPTIONAL_APP_URLS = [
  "NEXT_PUBLIC_DASHBOARD_URL",
  "NEXT_PUBLIC_SYNAPSE_URL",
  "NEXT_PUBLIC_THOUGHTS_URL",
  "NEXT_PUBLIC_AXON_URL",
  "NEXT_PUBLIC_PULSE_URL",
  "NEXT_PUBLIC_GYRUS_URL",
];

function envVarBlock(manifest: string, name: string): string {
  const match = manifest.match(
    new RegExp(
      String.raw`\[\[env_vars\]\]\s+name\s*=\s*"${name}"[\s\S]*?(?=\n\[\[env_vars\]\]|\n\[\[pre_deploy\]\]|$)`,
    ),
  );
  return match?.[0] || "";
}

describe("cortex deploy manifest", () => {
  it("keeps app URLs optional in the aws-dev container deploy", () => {
    const manifest = readFileSync(join(process.cwd(), "cortex-deploy.toml"), "utf8");

    for (const name of OPTIONAL_APP_URLS) {
      const block = envVarBlock(manifest, name);
      expect(block, `${name} block`).toContain('environments = ["aws-dev"]');
      expect(block, `${name} required flag`).toContain("required     = false");
    }
  });

  it("keeps enrollment optional on on-prem while validating it as an aws-dev pre-deploy gate", () => {
    const manifest = readFileSync(join(process.cwd(), "cortex-deploy.toml"), "utf8");
    for (const name of [
      "ENGRAM_AXON_ENROLLMENT_API_KEY",
      "ENGRAM_ENROLLMENT_SIGNING_KEY_ID",
      "ENGRAM_ENROLLMENT_SIGNING_PRIVATE_KEY",
      "ENGRAM_ENROLLMENT_SIGNING_PUBLIC_KEY",
      "ENGRAM_ENROLLMENT_SIGNING_NOT_BEFORE",
      "ENGRAM_ENROLLMENT_SIGNING_NOT_AFTER",
    ]) {
      const block = envVarBlock(manifest, name);
      expect(block).toContain("required     = false");
      expect(block).toContain('environments = ["on-prem", "aws-dev"]');
    }
    expect(manifest).toContain("node scripts/validate-enrollment-startup.mjs");
  });
});
