import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Set env before importing
process.env.ENGRAM_JWT_SECRET='test-s...ngth';

const { consoleInfoSpy, consoleWarnSpy } = vi.hoisted(() => ({
  consoleInfoSpy: vi.spyOn(console, 'info').mockImplementation(() => {}),
  consoleWarnSpy: vi.spyOn(console, 'warn').mockImplementation(() => {}),
}));

import { mockPrisma } from '../../mocks/prisma';
import { generateTokenPair } from '@/lib/jwt';
import { _resetRateLimitForTests } from '@/lib/rate-limit';
import { POST } from '@/app/api/auth/refresh/route';

function createMockRequest(options?: {
  cookies?: Record<string, string>;
  body?: object;
}) {
  const request = new Request('http://localhost:3104/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
  const nextRequest = new NextRequest(request);
  if (options?.cookies) {
    for (const [k, v] of Object.entries(options.cookies)) {
      nextRequest.cookies.set(k, v);
    }
  }
  return nextRequest;
}

describe('POST /api/auth/refresh', () => {
  beforeEach(() => {
    _resetRateLimitForTests();
    Object.values(mockPrisma).forEach((model) => {
      Object.values(model).forEach((fn) => (fn as any).mockReset());
    });
  });

  it('returns 401 for missing refresh token', async () => {
    const res = await POST(createMockRequest());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain('Refresh token required');
  });

  it('returns 401 for access token used as refresh (type check)', async () => {
    const { accessToken } = await generateTokenPair({ id: 'user-1', role: 'USER' });
    const res = await POST(
      createMockRequest({ cookies: { 'engram-refresh': accessToken } }),
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain('Invalid token type');
  });

  it('returns 200 with new token pair for valid refresh', async () => {
    const { refreshToken } = await generateTokenPair({ id: 'user-1', role: 'USER' });

    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      role: 'USER',
      email: 'test@example.com',
    });
    // Atomic rotation (ADR-031): consume the presented token (updateMany count
    // 1 = won) + create the successor; deleteMany is the post-commit sweep.
    mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.refreshToken.create.mockResolvedValue({});
    mockPrisma.refreshToken.deleteMany.mockResolvedValue({ count: 0 });

    const res = await POST(
      createMockRequest({ cookies: { 'engram-refresh': refreshToken } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accessToken).toBeDefined();
    expect(mockPrisma.refreshToken.create).toHaveBeenCalled();
    expect(consoleInfoSpy).toHaveBeenCalled();
  });

  it('returns the rotated refresh token for native body refresh requests', async () => {
    const { refreshToken } = await generateTokenPair({ id: 'user-1', role: 'USER' });

    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      role: 'USER',
      email: 'test@example.com',
    });
    mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.refreshToken.create.mockResolvedValue({});
    mockPrisma.refreshToken.deleteMany.mockResolvedValue({ count: 0 });

    const res = await POST(
      createMockRequest({ body: { refreshToken } }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accessToken).toBeDefined();
    expect(body.refreshToken).toBeDefined();
    expect(body.tokenType).toBe('Bearer');
    expect(body.expiresIn).toBe(900);
  });

  it('logs a warning when the refresh token is missing', async () => {
    const res = await POST(createMockRequest());
    expect(res.status).toBe(401);
    expect(consoleWarnSpy).toHaveBeenCalled();
  });

  it('theft detection: revokes the family when the token is not in the DB (lost the rotation)', async () => {
    const { refreshToken } = await generateTokenPair({ id: 'user-1', role: 'USER' });

    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', role: 'USER' });
    // Consume finds nothing (updateMany count 0 → lost/already consumed), and
    // the token is not in the DB (findUnique null → no grace) → family revoke.
    mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.refreshToken.findUnique.mockResolvedValue(null);
    mockPrisma.refreshToken.deleteMany.mockResolvedValue({ count: 3 });

    const res = await POST(
      createMockRequest({ cookies: { 'engram-refresh': refreshToken } }),
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain('Session expired');

    expect(mockPrisma.refreshToken.create).not.toHaveBeenCalled();
    // The whole family was revoked.
    expect(mockPrisma.refreshToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
    });
  });
});
