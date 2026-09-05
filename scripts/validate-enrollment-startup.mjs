import { SignJWT, compactVerify, importPKCS8, importSPKI } from "jose";

const RFC3339_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function required(name) {
  const value = process.env[name]?.trim().replace(/\\n/g, "\n");
  if (!value) throw new Error(`${name} must be configured for Cite enrollment signing.`);
  return value;
}

function validity(prefix) {
  const beforeRaw = required(`${prefix}_NOT_BEFORE`);
  const afterRaw = required(`${prefix}_NOT_AFTER`);
  for (const [name, value] of [[`${prefix}_NOT_BEFORE`, beforeRaw], [`${prefix}_NOT_AFTER`, afterRaw]]) {
    if (!RFC3339_INSTANT.test(value) || Number.isNaN(new Date(value).getTime())) {
      throw new Error(`${name} must be an RFC 3339 timestamp with an explicit offset.`);
    }
  }
  const notBefore = new Date(beforeRaw);
  const notAfter = new Date(afterRaw);
  if (notBefore >= notAfter) throw new Error(`${prefix}_NOT_AFTER must be after NOT_BEFORE.`);
  return { notBefore, notAfter };
}

function assertCurrent(prefix, now = new Date()) {
  const { notBefore, notAfter } = validity(prefix);
  if (now < notBefore || now >= notAfter) throw new Error("Enrollment active signing key is outside its validity interval.");
  return { notBefore, notAfter };
}

async function validate() {
  const keyId = required("ENGRAM_ENROLLMENT_SIGNING_KEY_ID");
  const { notBefore, notAfter } = assertCurrent("ENGRAM_ENROLLMENT_SIGNING");
  if (!process.env.ENGRAM_AXON_ENROLLMENT_API_KEY?.trim()) throw new Error("ENGRAM_AXON_ENROLLMENT_API_KEY must be configured.");
  const privateKey = await importPKCS8(required("ENGRAM_ENROLLMENT_SIGNING_PRIVATE_KEY"), "RS256");
  const publicKey = await importSPKI(required("ENGRAM_ENROLLMENT_SIGNING_PUBLIC_KEY"), "RS256");
  const probe = await new SignJWT({ probe: true }).setProtectedHeader({ alg: "RS256", typ: "engram-enrollment+jws", kid: keyId, contract_version: 1 }).sign(privateKey);
  await compactVerify(probe, publicKey, { algorithms: ["RS256"] });

  const fields = ["KEY_ID", "PUBLIC_KEY", "NOT_BEFORE", "NOT_AFTER"];
  const names = fields.map((field) => `ENGRAM_ENROLLMENT_OVERLAP_SIGNING_${field}`);
  const present = names.filter((name) => Boolean(process.env[name]?.trim()));
  if (present.length && present.length !== names.length) throw new Error("Enrollment overlap signing configuration must be complete.");
  if (present.length) {
    if (required("ENGRAM_ENROLLMENT_OVERLAP_SIGNING_KEY_ID") === keyId) throw new Error("Enrollment overlap signing key ID must differ from the active key ID.");
    const overlap = assertCurrent("ENGRAM_ENROLLMENT_OVERLAP_SIGNING");
    if (overlap.notAfter <= notBefore || overlap.notBefore >= notAfter || overlap.notAfter > notAfter) {
      throw new Error("Enrollment overlap key must share a non-empty validity interval and end no later than the active key.");
    }
    await importSPKI(required("ENGRAM_ENROLLMENT_OVERLAP_SIGNING_PUBLIC_KEY"), "RS256");
  }
}

validate().catch((cause) => {
  console.error("Enrollment startup validation failed:", cause instanceof Error ? cause.message : cause);
  process.exitCode = 1;
});
