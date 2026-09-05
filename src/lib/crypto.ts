import { createHash, createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * AES-256-GCM encryption for short-lived secrets that must be recoverable across
 * server instances/deploys — currently the ADR-031 successor refresh token,
 * stored on a rotated token's row for the ~30 s reuse-grace window so every
 * concurrent/retry refresh converges on the SAME successor (one chain).
 *
 * The key is derived (scrypt) from the environment's existing, deploy-stable JWT
 * signing material — no new secret is introduced, and a value encrypted on one
 * instance decrypts on another. Engram runs in two JWT modes with different
 * signing material:
 *   - HS256 (dev / on-prem, default): `ENGRAM_JWT_SECRET` (symmetric secret)
 *   - RS256 (aws-prod):               `ENGRAM_JWT_PRIVATE_KEY` (private key)
 *
 * ENCRYPT uses the material for the CURRENTLY configured algorithm
 * (`ENGRAM_JWT_ALGORITHM`, mirroring `jwt.ts:getJwtAlgorithm`), so new values
 * always migrate toward the canonical per-mode key. DECRYPT accepts ANY present
 * JWT material (mode key first, then the other var if set): this bridges a
 * key-material transition — e.g. the 2026-07-22 cutover from the temporary
 * `ENGRAM_JWT_SECRET` mitigation to the RS256 private key — so a successor
 * encrypted under the old key still decrypts instead of being misread as reuse
 * and revoking the whole session family. Once a transitional var is removed,
 * decrypt simply has one fewer candidate. See
 * docs/incidents/2026-07-22-refresh-grace-prod-500.md.
 */
function jwtAlgorithm(): "HS256" | "RS256" {
  // Mirrors jwt.ts:getJwtAlgorithm exactly (incl. throw-on-invalid) so the two
  // layers never disagree on the mode.
  const configured = process.env.ENGRAM_JWT_ALGORITHM?.trim().toUpperCase();
  if (!configured) return "HS256";
  if (configured === "HS256" || configured === "RS256") return configured;
  throw new Error("ENGRAM_JWT_ALGORITHM must be HS256 or RS256");
}
function keyMaterialForMode(): string | undefined {
  return jwtAlgorithm() === "RS256"
    ? process.env.ENGRAM_JWT_PRIVATE_KEY
    : process.env.ENGRAM_JWT_SECRET;
}
// Ordered decrypt candidates: the current mode's material first (hot-path fast),
// then any other present JWT material to bridge a key transition. De-duplicated.
function decryptCandidateMaterials(): string[] {
  const present = [
    keyMaterialForMode(),
    process.env.ENGRAM_JWT_SECRET,
    process.env.ENGRAM_JWT_PRIVATE_KEY,
  ].filter((m): m is string => typeof m === "string" && m.length > 0);
  const uniq = [...new Set(present)];
  return uniq.length > 0 ? uniq : ["dev-secret-change-in-production"];
}

// scrypt is deliberately slow; derive each material's key ONCE per process and
// cache it. Materials are deploy-stable, so re-deriving on every encrypt/decrypt
// would block the event loop on the hot refresh path under a refresh storm. A
// small Map (≤ 2–3 materials during a transition) keys the cache by material.
const keyCache = new Map<string, Buffer>();
function deriveKey(material: string): Buffer {
  const cached = keyCache.get(material);
  if (cached) return cached;
  // Distinct salt so this sub-key is not the JWT signing key itself.
  const key = scryptSync(material, "engram-secret-encryption-v1", 32);
  keyCache.set(material, key);
  return key;
}
function encryptionKey(): Buffer {
  const material = keyMaterialForMode();
  if (!material && process.env.NODE_ENV === "production") {
    throw new Error(
      "JWT signing material must be set in production " +
        "(ENGRAM_JWT_SECRET for HS256, ENGRAM_JWT_PRIVATE_KEY for RS256)",
    );
  }
  return deriveKey(material || "dev-secret-change-in-production");
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

/** Returns the plaintext if ANY present JWT material authenticates the payload;
 *  null on tamper / no-matching-key / malformed input — callers treat a null as
 *  "no recoverable replacement" and fall through to reuse handling. Trying every
 *  candidate keeps a benign in-grace token from being misread as reuse across a
 *  key-material transition (see module doc). */
export function decryptSecret(payload: string): string | null {
  const [ivB64, tagB64, encB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !encB64) return null;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const enc = Buffer.from(encB64, "base64");
  for (const material of decryptCandidateMaterials()) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", deriveKey(material), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
    } catch {
      // wrong key for this ciphertext — try the next candidate
    }
  }
  return null;
}
