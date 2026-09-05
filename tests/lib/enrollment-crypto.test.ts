import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";

import { signEnrollmentJws, validateEnrollmentSigningConfiguration } from "@/lib/enrollment-crypto";

const saved = { ...process.env };
let privatePem = "";
let publicPem = "";

function configure(overrides: Record<string, string> = {}) {
  Object.assign(process.env, {
    ENGRAM_AXON_ENROLLMENT_API_KEY: "test-axon-key",
    ENGRAM_ENROLLMENT_SIGNING_KEY_ID: "k2",
    ENGRAM_ENROLLMENT_SIGNING_PRIVATE_KEY: privatePem,
    ENGRAM_ENROLLMENT_SIGNING_PUBLIC_KEY: publicPem,
    ENGRAM_ENROLLMENT_SIGNING_NOT_BEFORE: "2020-01-01T00:00:00.000Z",
    ENGRAM_ENROLLMENT_SIGNING_NOT_AFTER: "2099-01-01T00:00:00.000Z",
    ENGRAM_ENROLLMENT_OVERLAP_SIGNING_KEY_ID: "",
    ENGRAM_ENROLLMENT_OVERLAP_SIGNING_PUBLIC_KEY: "",
    ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_BEFORE: "",
    ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_AFTER: "",
    ...overrides,
  });
}

describe("Cite enrollment signing-window mutation guards", () => {
  beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    privatePem = await exportPKCS8(pair.privateKey);
    publicPem = await exportSPKI(pair.publicKey);
  });
  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...saved };
  });

  it("enforces every active-key validity boundary at startup and signing time", async () => {
    configure({
      ENGRAM_ENROLLMENT_SIGNING_NOT_BEFORE: "2030-01-01T00:00:00.000Z",
      ENGRAM_ENROLLMENT_SIGNING_NOT_AFTER: "2030-01-01T00:00:01.000Z",
    });
    vi.useFakeTimers();

    vi.setSystemTime(new Date("2029-12-31T23:59:59.999Z"));
    await expect(validateEnrollmentSigningConfiguration()).rejects.toThrow("outside its validity interval");
    await expect(signEnrollmentJws({ test: true })).rejects.toThrow("outside its validity interval");

    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    await expect(validateEnrollmentSigningConfiguration()).resolves.toBeUndefined();
    await expect(signEnrollmentJws({ test: true })).resolves.toMatch(/^[^.]+\.[^.]+\.[^.]+$/);

    vi.setSystemTime(new Date("2030-01-01T00:00:00.999Z"));
    await expect(validateEnrollmentSigningConfiguration()).resolves.toBeUndefined();
    await expect(signEnrollmentJws({ test: true })).resolves.toMatch(/^[^.]+\.[^.]+\.[^.]+$/);

    vi.setSystemTime(new Date("2030-01-01T00:00:01.000Z"));
    await expect(validateEnrollmentSigningConfiguration()).rejects.toThrow("outside its validity interval");
    await expect(signEnrollmentJws({ test: true })).rejects.toThrow("outside its validity interval");
  });

  it("rejects duplicate and non-overlapping overlap keys at startup", async () => {
    configure({
      ENGRAM_ENROLLMENT_OVERLAP_SIGNING_KEY_ID: "k2",
      ENGRAM_ENROLLMENT_OVERLAP_SIGNING_PUBLIC_KEY: publicPem,
      ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_BEFORE: "2021-01-01T00:00:00.000Z",
      ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_AFTER: "2022-01-01T00:00:00.000Z",
    });
    await expect(validateEnrollmentSigningConfiguration()).rejects.toThrow("must differ");
    configure({
      ENGRAM_ENROLLMENT_OVERLAP_SIGNING_KEY_ID: "k1",
      ENGRAM_ENROLLMENT_OVERLAP_SIGNING_PUBLIC_KEY: publicPem,
      ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_BEFORE: "2001-01-01T00:00:00.000Z",
      ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_AFTER: "2002-01-01T00:00:00.000Z",
    });
    await expect(validateEnrollmentSigningConfiguration()).rejects.toThrow("non-empty validity interval");
  });

  it("rejects an overlap key that has left its declared window", async () => {
    configure({
      ENGRAM_ENROLLMENT_OVERLAP_SIGNING_KEY_ID: "k1",
      ENGRAM_ENROLLMENT_OVERLAP_SIGNING_PUBLIC_KEY: publicPem,
      ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_BEFORE: "2020-01-01T00:00:00.000Z",
      ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_AFTER: "2021-01-01T00:00:00.000Z",
    });
    await expect(validateEnrollmentSigningConfiguration()).rejects.toThrow("outside its validity interval");
  });

  it.each(["2020", "2099", "2020-01-01", "2020-01-01T00:00:00"]) ("rejects ambiguous signing timestamp %s", async (timestamp) => {
    configure({ ENGRAM_ENROLLMENT_SIGNING_NOT_BEFORE: timestamp });
    await expect(validateEnrollmentSigningConfiguration()).rejects.toThrow("explicit offset");
    await expect(signEnrollmentJws({ test: true })).rejects.toThrow("explicit offset");
  });
});
