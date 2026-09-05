import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { SignJWT, UnsecuredJWT, decodeProtectedHeader } from 'jose';

// Set env before importing jwt module
process.env.ENGRAM_JWT_SECRET = 'test-secret-for-jwt-tests-minimum-length';

import { generateTokenPair, getPublicJwks, verifyToken } from '@/lib/jwt';

describe('jwt', () => {
  it('generateTokenPair returns accessToken and refreshToken', async () => {
    const result = await generateTokenPair({ id: 'user-1', role: 'USER' });
    expect(result).toHaveProperty('accessToken');
    expect(result).toHaveProperty('refreshToken');
    expect(typeof result.accessToken).toBe('string');
    expect(typeof result.refreshToken).toBe('string');
  });

  it('access token is verifiable and contains correct payload', async () => {
    const { accessToken } = await generateTokenPair({ id: 'user-123', role: 'ADMIN' });
    const payload = await verifyToken(accessToken);
    expect(payload.userId).toBe('user-123');
    expect(payload.role).toBe('ADMIN');
    expect(payload.type).toBe('access');
  });

  it('refresh token contains type: refresh', async () => {
    const { refreshToken } = await generateTokenPair({ id: 'user-456' });
    const payload = await verifyToken(refreshToken);
    expect(payload.type).toBe('refresh');
    expect(payload.userId).toBe('user-456');
  });

  it('access token expires in 15 minutes', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { accessToken } = await generateTokenPair({ id: 'user-1' });
    const payload = await verifyToken(accessToken);
    const exp = (payload as any).exp as number;
    // Should be ~15 minutes (900 seconds) from now, allow 5s tolerance
    expect(exp - now).toBeGreaterThanOrEqual(895);
    expect(exp - now).toBeLessThanOrEqual(905);
  });

  it('refresh token expires in 30 days', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { refreshToken } = await generateTokenPair({ id: 'user-1' });
    const payload = await verifyToken(refreshToken);
    const exp = (payload as any).exp as number;
    const thirtyDays = 30 * 24 * 60 * 60;
    expect(exp - now).toBeGreaterThanOrEqual(thirtyDays - 5);
    expect(exp - now).toBeLessThanOrEqual(thirtyDays + 5);
  });

  it('verifyToken rejects expired tokens', async () => {
    const secret = new TextEncoder().encode('test-secret-for-jwt-tests-minimum-length');
    const expiredToken = await new SignJWT({ userId: 'x', type: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('engram')
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60) // expired 1 min ago
      .sign(secret);
    await expect(verifyToken(expiredToken)).rejects.toThrow();
  });

  it('verifyToken rejects tokens with wrong secret', async () => {
    const wrongSecret = new TextEncoder().encode('wrong-secret-entirely');
    const token = await new SignJWT({ userId: 'x', type: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('engram')
      .setExpirationTime('15m')
      .sign(wrongSecret);
    await expect(verifyToken(token)).rejects.toThrow();
  });

  it('verifyToken rejects malformed tokens', async () => {
    await expect(verifyToken('not-a-jwt')).rejects.toThrow();
    await expect(verifyToken('')).rejects.toThrow();
    await expect(verifyToken('a.b.c')).rejects.toThrow();
  });

  it('signs and verifies RS256 tokens and exposes the public key through JWKS', async () => {
    const previous = {
      algorithm: process.env.ENGRAM_JWT_ALGORITHM,
      keyId: process.env.ENGRAM_JWT_KEY_ID,
      privateKey: process.env.ENGRAM_JWT_PRIVATE_KEY,
      publicKey: process.env.ENGRAM_JWT_PUBLIC_KEY,
    };
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    process.env.ENGRAM_JWT_ALGORITHM = 'RS256';
    process.env.ENGRAM_JWT_KEY_ID = 'test-rs256-key';
    process.env.ENGRAM_JWT_PRIVATE_KEY = privateKey;
    process.env.ENGRAM_JWT_PUBLIC_KEY = publicKey;

    try {
      const { accessToken } = await generateTokenPair({ id: 'user-rs', role: 'USER' });
      expect(decodeProtectedHeader(accessToken)).toMatchObject({
        alg: 'RS256',
        kid: 'test-rs256-key',
      });
      await expect(verifyToken(accessToken)).resolves.toMatchObject({
        userId: 'user-rs',
        type: 'access',
      });
      await expect(getPublicJwks()).resolves.toMatchObject({
        keys: [expect.objectContaining({ kid: 'test-rs256-key', alg: 'RS256', use: 'sig' })],
      });
      const jwks = await getPublicJwks();
      expect(jwks.keys[0]).not.toHaveProperty('d');

      const hs256WithPublicKey = await new SignJWT({ userId: 'attacker', type: 'access' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer('engram')
        .setExpirationTime('15m')
        .sign(new TextEncoder().encode(publicKey));
      await expect(verifyToken(hs256WithPublicKey)).rejects.toThrow();

      const unsecured = new UnsecuredJWT({ userId: 'attacker', type: 'access' })
        .setIssuer('engram')
        .setExpirationTime('15m')
        .encode();
      await expect(verifyToken(unsecured)).rejects.toThrow();
    } finally {
      process.env.ENGRAM_JWT_ALGORITHM = previous.algorithm;
      process.env.ENGRAM_JWT_KEY_ID = previous.keyId;
      process.env.ENGRAM_JWT_PRIVATE_KEY = previous.privateKey;
      process.env.ENGRAM_JWT_PUBLIC_KEY = previous.publicKey;
    }
  });
});
