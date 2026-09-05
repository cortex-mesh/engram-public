import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";

import { validateEnrollmentSigningConfiguration } from "@/lib/enrollment-crypto";

const saved = { ...process.env };
let privatePem = "";
let publicPem = "";

function environment(
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ...saved,
    ENGRAM_AXON_ENROLLMENT_API_KEY: "validation-test-consumer",
    ENGRAM_ENROLLMENT_SIGNING_KEY_ID: "validation-test-k1",
    ENGRAM_ENROLLMENT_SIGNING_PRIVATE_KEY: privatePem,
    ENGRAM_ENROLLMENT_SIGNING_PUBLIC_KEY: publicPem,
    ENGRAM_ENROLLMENT_SIGNING_NOT_BEFORE: "2020-01-01T00:00:00.000Z",
    ENGRAM_ENROLLMENT_SIGNING_NOT_AFTER: "2099-01-01T00:00:00.000Z",
    ENGRAM_ENROLLMENT_OVERLAP_SIGNING_KEY_ID: "",
    ENGRAM_ENROLLMENT_OVERLAP_SIGNING_PUBLIC_KEY: "",
    ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_BEFORE: "",
    ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_AFTER: "",
    ...overrides,
  };
}

async function sourceValid(env: NodeJS.ProcessEnv): Promise<boolean> {
  process.env = env;
  try {
    await validateEnrollmentSigningConfiguration();
    return true;
  } catch {
    return false;
  }
}

function scriptValid(env: NodeJS.ProcessEnv): boolean {
  return (
    spawnSync(process.execPath, ["scripts/validate-enrollment-startup.mjs"], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
    }).status === 0
  );
}

describe("enrollment startup validation equivalence", () => {
  beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    privatePem = await exportPKCS8(pair.privateKey);
    publicPem = await exportSPKI(pair.publicKey);
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it.each([
    ["complete active configuration", {}],
    ["missing machine credential", { ENGRAM_AXON_ENROLLMENT_API_KEY: "" }],
    [
      "all enrollment variables explicitly empty as deployment inputs",
      {
        ENGRAM_AXON_ENROLLMENT_API_KEY: "",
        ENGRAM_ENROLLMENT_SIGNING_KEY_ID: "",
        ENGRAM_ENROLLMENT_SIGNING_PRIVATE_KEY: "",
        ENGRAM_ENROLLMENT_SIGNING_PUBLIC_KEY: "",
        ENGRAM_ENROLLMENT_SIGNING_NOT_BEFORE: "",
        ENGRAM_ENROLLMENT_SIGNING_NOT_AFTER: "",
        ENGRAM_ENROLLMENT_OVERLAP_SIGNING_KEY_ID: "",
        ENGRAM_ENROLLMENT_OVERLAP_SIGNING_PUBLIC_KEY: "",
        ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_BEFORE: "",
        ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_AFTER: "",
      },
    ],
    [
      "expired signing window",
      { ENGRAM_ENROLLMENT_SIGNING_NOT_AFTER: "2020-01-01T00:00:00.000Z" },
    ],
    [
      "future signing window",
      { ENGRAM_ENROLLMENT_SIGNING_NOT_BEFORE: "2099-01-01T00:00:00.000Z" },
    ],
    [
      "reversed signing window",
      {
        ENGRAM_ENROLLMENT_SIGNING_NOT_BEFORE: "2099-01-01T00:00:00.000Z",
        ENGRAM_ENROLLMENT_SIGNING_NOT_AFTER: "2020-01-01T00:00:00.000Z",
      },
    ],
    [
      "ambiguous signing timestamp",
      { ENGRAM_ENROLLMENT_SIGNING_NOT_AFTER: "2099-01-01" },
    ],
    [
      "mismatched active key pair",
      {
        ENGRAM_ENROLLMENT_SIGNING_PUBLIC_KEY:
          "-----BEGIN PUBLIC KEY-----\\ninvalid\\n-----END PUBLIC KEY-----",
      },
    ],
    [
      "partial overlap",
      { ENGRAM_ENROLLMENT_OVERLAP_SIGNING_KEY_ID: "old-kid" },
    ],
    [
      "same overlap kid",
      {
        ENGRAM_ENROLLMENT_OVERLAP_SIGNING_KEY_ID: "validation-test-k1",
        ENGRAM_ENROLLMENT_OVERLAP_SIGNING_PUBLIC_KEY: publicPem,
        ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_BEFORE:
          "2020-01-01T00:00:00.000Z",
        ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_AFTER: "2099-01-01T00:00:00.000Z",
      },
    ],
    [
      "non-overlapping overlap window",
      {
        ENGRAM_ENROLLMENT_OVERLAP_SIGNING_KEY_ID: "old-kid",
        ENGRAM_ENROLLMENT_OVERLAP_SIGNING_PUBLIC_KEY: publicPem,
        ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_BEFORE:
          "2010-01-01T00:00:00.000Z",
        ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_AFTER: "2011-01-01T00:00:00.000Z",
      },
    ],
    [
      "overlap ending after active key",
      {
        ENGRAM_ENROLLMENT_OVERLAP_SIGNING_KEY_ID: "old-kid",
        ENGRAM_ENROLLMENT_OVERLAP_SIGNING_PUBLIC_KEY: publicPem,
        ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_BEFORE:
          "2020-01-01T00:00:00.000Z",
        ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_AFTER: "2100-01-01T00:00:00.000Z",
      },
    ],
  ])(
    "the deploy script and runtime validator agree for %s",
    async (_name, overrides) => {
      const env = environment(overrides);
      expect(scriptValid(env)).toBe(await sourceValid({ ...env }));
    },
  );
});
