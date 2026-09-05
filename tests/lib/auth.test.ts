import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';

// Set env vars before importing modules
process.env.ENGRAM_JWT_SECRET = 'test-secret-for-auth-tests-minimum-length';
process.env.ENGRAM_INTERNAL_API_KEY = 'test-internal-api-key-12345';

import { authenticateRequest } from '@/lib/auth';
import { generateTokenPair } from '@/lib/jwt';

function createMockRequest(options: {
  method?: string;
  body?: object;
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
  url?: string;
}) {
  const url = options.url || 'http://localhost:3104/api/test';
  const request = new Request(url, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const nextRequest = new NextRequest(request);
  if (options.cookies) {
    for (const [k, v] of Object.entries(options.cookies)) {
      nextRequest.cookies.set(k, v);
    }
  }
  return nextRequest;
}

describe('authenticateRequest', () => {
  it('returns null for request with no auth', async () => {
    const req = createMockRequest({});
    const result = await authenticateRequest(req);
    expect(result).toBeNull();
  });

  it('returns userId/role for valid JWT in engram-access cookie', async () => {
    const { accessToken } = await generateTokenPair({ id: 'user-abc', role: 'USER' });
    const req = createMockRequest({
      cookies: { 'engram-access': accessToken },
    });
    const result = await authenticateRequest(req);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('user-abc');
    expect(result!.role).toBe('USER');
  });

  it('returns userId/role for valid JWT in Authorization Bearer header', async () => {
    const { accessToken } = await generateTokenPair({ id: 'user-xyz', role: 'ADMIN' });
    const req = createMockRequest({
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const result = await authenticateRequest(req);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('user-xyz');
    expect(result!.role).toBe('ADMIN');
  });

  it('returns internal auth for valid X-Internal-API-Key header', async () => {
    const req = createMockRequest({
      headers: { 'x-internal-api-key': 'test-internal-api-key-12345' },
    });
    const result = await authenticateRequest(req);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('internal');
    expect(result!.role).toBe('ADMIN');
  });

  it('returns null for invalid JWT', async () => {
    const req = createMockRequest({
      cookies: { 'engram-access': 'invalid-jwt-token' },
    });
    const result = await authenticateRequest(req);
    expect(result).toBeNull();
  });

  it('returns null for wrong API key', async () => {
    const req = createMockRequest({
      headers: { 'x-internal-api-key': 'wrong-key' },
    });
    const result = await authenticateRequest(req);
    expect(result).toBeNull();
  });

  it('returns null for refresh token used in cookie (type check)', async () => {
    const { refreshToken } = await generateTokenPair({ id: 'user-123' });
    const req = createMockRequest({
      cookies: { 'engram-access': refreshToken },
    });
    const result = await authenticateRequest(req);
    expect(result).toBeNull();
  });
});
