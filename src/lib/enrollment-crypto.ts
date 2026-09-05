import { createHash } from "node:crypto";
import {
  SignJWT,
  compactVerify,
  exportJWK,
  importPKCS8,
  importSPKI,
  type JWK,
} from "jose";

const CONTRACT_VERSION = 1;
const JWS_TYP = "engram-enrollment+jws";
type EnrollmentKey = Awaited<ReturnType<typeof importPKCS8>>;
let cachedSigningKey: { pem: string; key: EnrollmentKey } | undefined;
const cachedPublicKeys = new Map<string, EnrollmentKey>();

// Key material is resolved from ONE of two sources, chosen by whether
// ENGRAM_ENROLLMENT_SIGNING_SECRET_ID is set:
//
//   secret id set  -> fetched from Secrets Manager once, cached in-process
//   secret id unset -> read from individual environment variables (unchanged)
//
// The indirection exists because AWS Lambda caps a function's configuration
// update request at 5120 bytes, and the five signing fields are ~3.3 KB of
// that budget on their own. aws-prod runs on Lambda (ADR-025), so injecting
// them as env vars made `UpdateFunctionConfiguration` fail with HTTP 413 and
// rolled the whole web stack back. aws-dev and on-prem run as containers with
// an env file and have no such ceiling, which is why only prod was affected.
// See docs/runbooks/aws-prod-lambda-env-budget.md.
let secretOverlay: Record<string, string> | null = null;
let secretLoad: Promise<Record<string, string>> | null = null;

// The dedicated secret's contract (enrollment-signing-secret-provisioning.md)
// mapped onto the variable names the rest of this module already reads.
const SECRET_FIELD_TO_ENV: Record<string, string> = {
  kid: "ENGRAM_ENROLLMENT_SIGNING_KEY_ID",
  privateKeyPem: "ENGRAM_ENROLLMENT_SIGNING_PRIVATE_KEY",
  publicKeyPem: "ENGRAM_ENROLLMENT_SIGNING_PUBLIC_KEY",
  not_before: "ENGRAM_ENROLLMENT_SIGNING_NOT_BEFORE",
  not_after: "ENGRAM_ENROLLMENT_SIGNING_NOT_AFTER",
};

/**
 * Populate the in-process key-material cache when a secret id is configured.
 *
 * Deliberately lazy and never on the startup path: ADR-034 §8.1 forbids any
 * enrollment work in `instrumentation.register()`, because on Lambda a throw
 * there executes at every cold start and would turn a Cite-scoped fault into a
 * suite-wide identity outage. A fetch failure here therefore surfaces on the
 * enrollment request only, where it becomes the contract's `503` deny.
 *
 * The in-flight promise is cached, not just the result, so concurrent first
 * requests share one API call instead of stampeding Secrets Manager.
 */
export async function hydrateEnrollmentSigningMaterial(): Promise<void> {
  const secretId = process.env.ENGRAM_ENROLLMENT_SIGNING_SECRET_ID?.trim();
  if (!secretId) return;
  if (secretOverlay) return;
  if (!secretLoad) {
    secretLoad = (async () => {
      const { readEnrollmentSigningSecret } = await import("@/lib/asm-client");
      const raw = await readEnrollmentSigningSecret(secretId);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const resolved: Record<string, string> = {};
      for (const [field, envName] of Object.entries(SECRET_FIELD_TO_ENV)) {
        const value = parsed[field];
        if (typeof value !== "string" || !value.trim())
          throw new Error(
            `Enrollment signing secret ${secretId} is missing "${field}".`,
          );
        resolved[envName] = value;
      }
      return resolved;
    })().catch((cause) => {
      // Do not cache a failure — the next request must be able to retry, or a
      // transient Secrets Manager blip would deny Cite until the next cold start.
      secretLoad = null;
      throw cause;
    });
  }
  secretOverlay = await secretLoad;
}

function required(name: string): string {
  const raw = secretOverlay?.[name] ?? process.env[name];
  const value = raw?.trim().replace(/\\n/g, "\n");
  if (!value)
    throw new Error(`${name} must be configured for Cite enrollment signing.`);
  return value;
}

function iso(value: string, name: string): string {
  // Date.parse accepts ambiguous shortcuts such as "2020". Deployment key
  // windows are a signed-security boundary, so accept only a complete RFC
  // 3339 instant with an explicit UTC designator or numeric offset.
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  ) {
    throw new Error(
      `${name} must be an RFC 3339 timestamp with an explicit offset.`,
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw new Error(`${name} must be an RFC 3339 timestamp.`);
  return parsed.toISOString();
}

function validity(
  prefix: "ENGRAM_ENROLLMENT_SIGNING" | "ENGRAM_ENROLLMENT_OVERLAP_SIGNING",
) {
  const notBefore = new Date(
    iso(required(`${prefix}_NOT_BEFORE`), `${prefix}_NOT_BEFORE`),
  );
  const notAfter = new Date(
    iso(required(`${prefix}_NOT_AFTER`), `${prefix}_NOT_AFTER`),
  );
  if (notBefore >= notAfter)
    throw new Error(`${prefix}_NOT_AFTER must be after NOT_BEFORE.`);
  return { notBefore, notAfter };
}

function assertSigningWindow(
  prefix: "ENGRAM_ENROLLMENT_SIGNING" | "ENGRAM_ENROLLMENT_OVERLAP_SIGNING",
  now = new Date(),
): void {
  const { notBefore, notAfter } = validity(prefix);
  if (now < notBefore || now >= notAfter)
    throw new Error(
      `Enrollment ${prefix === "ENGRAM_ENROLLMENT_SIGNING" ? "active" : "overlap"} signing key is outside its validity interval.`,
    );
}

function assertActiveSigningWindow(now = new Date()): void {
  assertSigningWindow("ENGRAM_ENROLLMENT_SIGNING", now);
}

export function enrollmentJwsHash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

async function signingKey(): Promise<EnrollmentKey> {
  const pem = required("ENGRAM_ENROLLMENT_SIGNING_PRIVATE_KEY");
  if (cachedSigningKey?.pem === pem) return cachedSigningKey.key;
  const key = await importPKCS8(pem, "RS256");
  cachedSigningKey = { pem, key };
  return key;
}

async function publicKey(pem: string): Promise<EnrollmentKey> {
  const cached = cachedPublicKeys.get(pem);
  if (cached) return cached;
  const key = await importSPKI(pem, "RS256");
  cachedPublicKeys.set(pem, key);
  return key;
}

/** Check only what a request needs to safely issue state. Full active/overlap
 * set validation remains the strict pre-deploy gate. */
export async function assertEnrollmentSigningAvailable(): Promise<void> {
  await hydrateEnrollmentSigningMaterial();
  assertActiveSigningWindow();
  required("ENGRAM_ENROLLMENT_SIGNING_KEY_ID");
  await signingKey();
}

export async function signEnrollmentJws(
  payload: Record<string, unknown>,
): Promise<string> {
  await assertEnrollmentSigningAvailable();
  return new SignJWT(payload)
    .setProtectedHeader({
      alg: "RS256",
      typ: JWS_TYP,
      kid: required("ENGRAM_ENROLLMENT_SIGNING_KEY_ID"),
      contract_version: CONTRACT_VERSION,
    })
    .sign(await signingKey());
}

async function publishedKey(
  prefix: "ENGRAM_ENROLLMENT_SIGNING" | "ENGRAM_ENROLLMENT_OVERLAP_SIGNING",
  status: "active" | "overlap",
): Promise<JWK & Record<string, unknown>> {
  const key = await publicKey(required(`${prefix}_PUBLIC_KEY`));
  return {
    ...(await exportJWK(key)),
    kid: required(`${prefix}_KEY_ID`),
    alg: "RS256",
    use: "sig",
    contract_version: CONTRACT_VERSION,
    not_before: iso(required(`${prefix}_NOT_BEFORE`), `${prefix}_NOT_BEFORE`),
    not_after: iso(required(`${prefix}_NOT_AFTER`), `${prefix}_NOT_AFTER`),
    status,
  };
}

/** Active key plus an optional, explicitly bounded overlap key. Retired keys
 * are never emitted, so a consumer encountering one must deny rather than
 * attempting an implicit fallback. */
export async function getEnrollmentSigningKeys(): Promise<{
  contract_version: number;
  keys: Array<JWK & Record<string, unknown>>;
}> {
  // Verification material must remain available after a signing-key expiry:
  // consumers need it to verify already-issued state and then deny it by the
  // published validity interval. This path intentionally never reads private
  // key material or asserts an active signing window.
  await hydrateEnrollmentSigningMaterial();
  const keys = [await publishedKey("ENGRAM_ENROLLMENT_SIGNING", "active")];
  const overlapNames = [
    "ENGRAM_ENROLLMENT_OVERLAP_SIGNING_KEY_ID",
    "ENGRAM_ENROLLMENT_OVERLAP_SIGNING_PUBLIC_KEY",
    "ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_BEFORE",
    "ENGRAM_ENROLLMENT_OVERLAP_SIGNING_NOT_AFTER",
  ];
  // A malformed optional overlap must not hide the healthy active public key.
  // The strict deployment validator rejects partial sets before aws-dev deploy.
  if (overlapNames.every((name) => Boolean(process.env[name]?.trim()))) {
    keys.push(
      await publishedKey("ENGRAM_ENROLLMENT_OVERLAP_SIGNING", "overlap"),
    );
  }
  return { contract_version: CONTRACT_VERSION, keys };
}

/** Fail startup before traffic when a declared deployment lacks a usable
 * enrollment key set. The probe verifies the active private/public pair rather
 * than merely checking that PEM-looking strings were supplied. */
export async function validateEnrollmentSigningConfiguration(): Promise<void> {
  await hydrateEnrollmentSigningMaterial();
  const keyId = required("ENGRAM_ENROLLMENT_SIGNING_KEY_ID");
  const { notBefore, notAfter } = validity("ENGRAM_ENROLLMENT_SIGNING");
  assertActiveSigningWindow();
  if (!process.env.ENGRAM_AXON_ENROLLMENT_API_KEY?.trim())
    throw new Error("ENGRAM_AXON_ENROLLMENT_API_KEY must be configured.");
  const privateKey = await importPKCS8(
    required("ENGRAM_ENROLLMENT_SIGNING_PRIVATE_KEY"),
    "RS256",
  );
  const publicKey = await importSPKI(
    required("ENGRAM_ENROLLMENT_SIGNING_PUBLIC_KEY"),
    "RS256",
  );
  const probe = await new SignJWT({ probe: true })
    .setProtectedHeader({
      alg: "RS256",
      typ: JWS_TYP,
      kid: keyId,
      contract_version: CONTRACT_VERSION,
    })
    .sign(privateKey);
  await compactVerify(probe, publicKey, { algorithms: ["RS256"] });
  const overlapNames = ["KEY_ID", "PUBLIC_KEY", "NOT_BEFORE", "NOT_AFTER"].map(
    (suffix) => `ENGRAM_ENROLLMENT_OVERLAP_SIGNING_${suffix}`,
  );
  const present = overlapNames.filter((name) =>
    Boolean(process.env[name]?.trim()),
  );
  if (present.length && present.length !== overlapNames.length)
    throw new Error(
      "Enrollment overlap signing configuration must be complete.",
    );
  if (present.length) {
    const overlapKid = required("ENGRAM_ENROLLMENT_OVERLAP_SIGNING_KEY_ID");
    if (overlapKid === keyId)
      throw new Error(
        "Enrollment overlap signing key ID must differ from the active key ID.",
      );
    const { notBefore: overlapBefore, notAfter: overlapAfter } = validity(
      "ENGRAM_ENROLLMENT_OVERLAP_SIGNING",
    );
    if (
      overlapAfter <= notBefore ||
      overlapBefore >= notAfter ||
      overlapAfter > notAfter
    ) {
      throw new Error(
        "Enrollment overlap key must share a non-empty validity interval and end no later than the active key.",
      );
    }
    assertSigningWindow("ENGRAM_ENROLLMENT_OVERLAP_SIGNING");
    await importSPKI(
      required("ENGRAM_ENROLLMENT_OVERLAP_SIGNING_PUBLIC_KEY"),
      "RS256",
    );
  }
}
