import { describe, it, expect, afterEach } from 'vitest';
import { sha256, encryptSecret, decryptSecret } from '@/lib/crypto';

describe('sha256', () => {
  it('returns a consistent hex string', () => {
    const hash1 = sha256('hello');
    const hash2 = sha256('hello');
    expect(hash1).toBe(hash2);
  });

  it('different inputs produce different hashes', () => {
    const hash1 = sha256('hello');
    const hash2 = sha256('world');
    expect(hash1).not.toBe(hash2);
  });

  it('output is 64 chars (256 bits in hex)', () => {
    const hash = sha256('test input');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('encryptSecret / decryptSecret (ADR-031 successor-token storage)', () => {
  const RS256_KEY =
    '-----BEGIN PRIVATE KEY-----\nfake-rs256-key-material-stable\n-----END PRIVATE KEY-----';
  const saved = {
    secret: process.env.ENGRAM_JWT_SECRET,
    priv: process.env.ENGRAM_JWT_PRIVATE_KEY,
    algo: process.env.ENGRAM_JWT_ALGORITHM,
    nodeEnv: process.env.NODE_ENV,
  };
  const setEnv = (v: {
    secret?: string;
    priv?: string;
    algo?: string;
    nodeEnv?: string;
  }) => {
    const put = (k: string, val: string | undefined) => {
      if (val === undefined) delete process.env[k];
      else process.env[k] = val;
    };
    if ('secret' in v) put('ENGRAM_JWT_SECRET', v.secret);
    if ('priv' in v) put('ENGRAM_JWT_PRIVATE_KEY', v.priv);
    if ('algo' in v) put('ENGRAM_JWT_ALGORITHM', v.algo);
    if ('nodeEnv' in v) {
      // NODE_ENV is readonly-typed; assign through a cast.
      (process.env as Record<string, string | undefined>).NODE_ENV = v.nodeEnv;
    }
  };
  afterEach(() => {
    setEnv({
      secret: saved.secret,
      priv: saved.priv,
      algo: saved.algo,
      nodeEnv: saved.nodeEnv,
    });
  });

  it('round-trips in HS256 mode with the symmetric secret (dev / on-prem)', () => {
    setEnv({ algo: 'HS256', secret: 'hs256-symmetric-secret', priv: undefined });
    const token = 'successor-refresh-token-abc123';
    const enc = encryptSecret(token);
    expect(enc).not.toContain(token);
    expect(decryptSecret(enc)).toBe(token);
  });

  // Regression guard for the 2026-07-22 prod-500: aws-prod signs with RS256 and
  // has NO ENGRAM_JWT_SECRET — only ENGRAM_JWT_PRIVATE_KEY. encryptSecret must
  // key off the private key and NOT throw. (Was green on dev + in tests before
  // because dev sets ENGRAM_JWT_SECRET; that masked the bug.)
  it('round-trips in aws-prod mode: RS256, private key present, NO ENGRAM_JWT_SECRET, production', () => {
    setEnv({ algo: 'RS256', secret: undefined, priv: RS256_KEY, nodeEnv: 'production' });
    const token = 'prod-successor-token-xyz';
    expect(() => encryptSecret(token)).not.toThrow();
    const enc = encryptSecret(token);
    expect(decryptSecret(enc)).toBe(token);
  });

  // Guards the review-flagged cleanup trap: in RS256 the key is derived from the
  // private key and the (temporary, mitigation) ENGRAM_JWT_SECRET is IGNORED even
  // when present — so removing that env var must NOT change the key, i.e. a token
  // encrypted while both were set must still decrypt after the secret is dropped.
  it('RS256 ignores a co-present ENGRAM_JWT_SECRET → removing it is a safe no-op', () => {
    // Prod's current interim state: BOTH the temp secret and the real key set.
    setEnv({ algo: 'RS256', secret: 'temporary-mitigation-secret', priv: RS256_KEY, nodeEnv: 'production' });
    const enc = encryptSecret('in-flight-grace-successor');
    // Operator drops the now-redundant temp secret; private key unchanged.
    setEnv({ secret: undefined });
    expect(decryptSecret(enc)).toBe('in-flight-grace-successor');
  });

  // The fix deploy itself changes key material once (mitigation keyed off the
  // interim secret; the fixed code keys off the RS256 private key). decrypt must
  // accept EITHER while both are present, so an in-grace successor written under
  // the old key still decrypts after cutover instead of routing to reuse →
  // revokeTokenFamily (a multi-device logout). Fails under a single-key decrypt.
  it('bridges the interim-secret → private-key cutover: old-key token still decrypts (no family-revoke)', () => {
    // Mitigation era: encryption keyed off the temporary secret.
    setEnv({ algo: 'HS256', secret: 'interim-mitigation-secret', priv: undefined });
    const enc = encryptSecret('in-grace-successor');
    // Fix deploy: RS256 keys off the private key, interim secret still on the Lambda.
    setEnv({ algo: 'RS256', priv: RS256_KEY, secret: 'interim-mitigation-secret' });
    expect(decryptSecret(enc)).toBe('in-grace-successor');
    // New values migrate forward onto the private key; still decrypt after the
    // interim var is later removed.
    const post = encryptSecret('post-cutover');
    setEnv({ secret: undefined });
    expect(decryptSecret(post)).toBe('post-cutover');
  });

  it('throws on an invalid ENGRAM_JWT_ALGORITHM (parity with jwt.ts)', () => {
    setEnv({ algo: 'RS512', secret: 'x', priv: undefined, nodeEnv: 'production' });
    expect(() => encryptSecret('y')).toThrow(/must be HS256 or RS256/);
  });

  it('throws in production when the mode-required signing material is absent', () => {
    // RS256 configured but no private key present.
    setEnv({ algo: 'RS256', secret: 'irrelevant-in-rs256', priv: undefined, nodeEnv: 'production' });
    expect(() => encryptSecret('x')).toThrow(/must be set in production/);
  });

  it('decryptSecret returns null on tampered / malformed input', () => {
    setEnv({ algo: 'HS256', secret: 'some-secret', priv: undefined });
    const enc = encryptSecret('payload');
    const [iv, tag, ct] = enc.split('.');
    // Corrupt the IV → GCM auth tag no longer matches → decryption fails.
    const badIv = (iv[0] === 'A' ? 'B' : 'A') + iv.slice(1);
    expect(decryptSecret([badIv, tag, ct].join('.'))).toBeNull();
    // Wrong key (different material) also fails auth.
    setEnv({ secret: 'a-different-secret' });
    expect(decryptSecret(enc)).toBeNull();
    // Malformed shapes.
    expect(decryptSecret('not.valid.data')).toBeNull();
    expect(decryptSecret('onlyonepart')).toBeNull();
  });
});
