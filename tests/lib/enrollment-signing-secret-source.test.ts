import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";

const readEnrollmentSigningSecret = vi.fn();
vi.mock("@/lib/asm-client", () => ({
  readEnrollmentSigningSecret: (id: string) => readEnrollmentSigningSecret(id),
}));

const saved = { ...process.env };
let privatePem = "";
let publicPem = "";

const SECRET_ID = "cortex/prod/engram/enrollment-signing";

function secretPayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    kid: "prod-kid",
    privateKeyPem: privatePem,
    publicKeyPem: publicPem,
    not_before: "2020-01-01T00:00:00.000Z",
    not_after: "2099-01-01T00:00:00.000Z",
    ...overrides,
  });
}

// Each case needs a module with a cold cache: hydration memoises per process.
async function freshModule() {
  vi.resetModules();
  return import("@/lib/enrollment-crypto");
}

describe("enrollment signing material source", () => {
  beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    privatePem = await exportPKCS8(pair.privateKey);
    publicPem = await exportSPKI(pair.publicKey);
  });

  afterEach(() => {
    process.env = { ...saved };
    readEnrollmentSigningSecret.mockReset();
  });

  it("signs from Secrets Manager when only the secret id is configured", async () => {
    // This is the aws-prod shape: the five fields are NOT environment
    // variables, because they exceed Lambda's configuration-request limit.
    process.env.ENGRAM_ENROLLMENT_SIGNING_SECRET_ID = SECRET_ID;
    for (const name of [
      "ENGRAM_ENROLLMENT_SIGNING_KEY_ID",
      "ENGRAM_ENROLLMENT_SIGNING_PRIVATE_KEY",
      "ENGRAM_ENROLLMENT_SIGNING_PUBLIC_KEY",
      "ENGRAM_ENROLLMENT_SIGNING_NOT_BEFORE",
      "ENGRAM_ENROLLMENT_SIGNING_NOT_AFTER",
    ])
      delete process.env[name];
    readEnrollmentSigningSecret.mockResolvedValue(secretPayload());

    const { signEnrollmentJws } = await freshModule();
    const jws = await signEnrollmentJws({ probe: true });

    expect(jws.split(".")).toHaveLength(3);
    expect(readEnrollmentSigningSecret).toHaveBeenCalledWith(SECRET_ID);
    const header = JSON.parse(
      Buffer.from(jws.split(".")[0]!, "base64url").toString("utf8"),
    );
    expect(header.kid).toBe("prod-kid");
  });

  it("fetches once and caches across concurrent first requests", async () => {
    // A cold Lambda can take several enrollment requests at once; they must
    // share one fetch rather than stampede Secrets Manager.
    process.env.ENGRAM_ENROLLMENT_SIGNING_SECRET_ID = SECRET_ID;
    readEnrollmentSigningSecret.mockResolvedValue(secretPayload());

    const { signEnrollmentJws } = await freshModule();
    await Promise.all([
      signEnrollmentJws({ n: 1 }),
      signEnrollmentJws({ n: 2 }),
      signEnrollmentJws({ n: 3 }),
    ]);
    await signEnrollmentJws({ n: 4 });

    expect(readEnrollmentSigningSecret).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failure, so a transient outage can recover", async () => {
    // Caching the rejection would deny Cite until the next cold start.
    process.env.ENGRAM_ENROLLMENT_SIGNING_SECRET_ID = SECRET_ID;
    readEnrollmentSigningSecret
      .mockRejectedValueOnce(new Error("throttled"))
      .mockResolvedValue(secretPayload());

    const { signEnrollmentJws } = await freshModule();
    await expect(signEnrollmentJws({ probe: true })).rejects.toThrow("throttled");
    await expect(signEnrollmentJws({ probe: true })).resolves.toContain(".");
    expect(readEnrollmentSigningSecret).toHaveBeenCalledTimes(2);
  });

  it("rejects a secret missing a contract field rather than signing with a gap", async () => {
    process.env.ENGRAM_ENROLLMENT_SIGNING_SECRET_ID = SECRET_ID;
    readEnrollmentSigningSecret.mockResolvedValue(
      secretPayload({ privateKeyPem: undefined }),
    );

    const { signEnrollmentJws } = await freshModule();
    await expect(signEnrollmentJws({ probe: true })).rejects.toThrow(
      /missing "privateKeyPem"/,
    );
  });

  it("reads environment variables and never calls Secrets Manager without a secret id", async () => {
    // aws-dev and on-prem shape — containers with an env file, unchanged.
    delete process.env.ENGRAM_ENROLLMENT_SIGNING_SECRET_ID;
    Object.assign(process.env, {
      ENGRAM_ENROLLMENT_SIGNING_KEY_ID: "dev-kid",
      ENGRAM_ENROLLMENT_SIGNING_PRIVATE_KEY: privatePem,
      ENGRAM_ENROLLMENT_SIGNING_PUBLIC_KEY: publicPem,
      ENGRAM_ENROLLMENT_SIGNING_NOT_BEFORE: "2020-01-01T00:00:00.000Z",
      ENGRAM_ENROLLMENT_SIGNING_NOT_AFTER: "2099-01-01T00:00:00.000Z",
    });

    const { signEnrollmentJws } = await freshModule();
    const jws = await signEnrollmentJws({ probe: true });

    const header = JSON.parse(
      Buffer.from(jws.split(".")[0]!, "base64url").toString("utf8"),
    );
    expect(header.kid).toBe("dev-kid");
    expect(readEnrollmentSigningSecret).not.toHaveBeenCalled();
  });

  it("accepts escaped-newline PEMs from either source", async () => {
    // aws-dev stores PEMs with escaped \n because the deploy renders the env
    // file as raw KEY=VALUE lines. The same un-escaping must apply to values
    // arriving from Secrets Manager, so one encoding works everywhere.
    process.env.ENGRAM_ENROLLMENT_SIGNING_SECRET_ID = SECRET_ID;
    readEnrollmentSigningSecret.mockResolvedValue(
      secretPayload({
        privateKeyPem: privatePem.replace(/\n/g, "\\n"),
        publicKeyPem: publicPem.replace(/\n/g, "\\n"),
      }),
    );

    const { signEnrollmentJws } = await freshModule();
    await expect(signEnrollmentJws({ probe: true })).resolves.toContain(".");
  });
});
