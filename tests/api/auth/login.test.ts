import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Set env before importing
process.env.ENGRAM_JWT_SECRET = 'test-secret-for-login-tests-minimum-length';

import { mockPrisma } from '../../mocks/prisma';
import { hashPassword } from '@/lib/password';
import { _resetRateLimitForTests } from '@/lib/rate-limit';
import { POST } from '@/app/api/auth/login/route';

function createMockRequest(body?: object, headers: Record<string, string> = {}) {
  const request = new Request('http://localhost:3104/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : JSON.stringify({}),
  });
  return new NextRequest(request);
}

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    _resetRateLimitForTests();
    process.env.ENGRAM_URL = 'https://login.dev.ctxhost.com';
    process.env.ENGRAM_ALLOWED_HOSTS = '';
    delete process.env.NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING;
    Object.values(mockPrisma).forEach((model) => {
      Object.values(model).forEach((fn) => (fn as any).mockReset());
    });
  });

  it('returns 401 for missing fields', async () => {
    const res1 = await POST(createMockRequest({ email: 'test@example.com' }));
    expect(res1.status).toBe(401);

    const res2 = await POST(createMockRequest({ password: 'securepass1' }));
    expect(res2.status).toBe(401);
  });

  it('rejects a conflicting client on the Cite host before user lookup', async () => {
    process.env.ENGRAM_ALLOWED_HOSTS = 'auth.citethemove.com';
    const response = await POST(createMockRequest(
      { email: 'user@example.com', password: 'password123', clientId: 'tradepost-web' },
      { host: 'auth.citethemove.com' },
    ));

    expect(response.status).toBe(400);
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects conflicting direct and nested client ids on the Cite host before user lookup', async () => {
    process.env.ENGRAM_ALLOWED_HOSTS = 'auth.citethemove.com';
    const response = await POST(createMockRequest(
      {
        email: 'user@example.com',
        password: 'password123',
        clientId: 'axon-web',
        redirectUri: '/authorize?client_id=tradepost-web',
      },
      { host: 'auth.citethemove.com' },
    ));

    expect(response.status).toBe(400);
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('returns 401 for nonexistent user', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const res = await POST(
      createMockRequest({ email: 'noone@example.com', password: 'securepass1' }),
    );
    expect(res.status).toBe(401);
  });

  it('records a login.failure audit event for an unknown account', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    await POST(createMockRequest({ email: 'noone@example.com', password: 'securepass1' }));
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'login.failure',
          outcome: 'failure',
          reason: 'no_account',
        }),
      }),
    );
  });

  it('records a login.success audit event', async () => {
    const passwordHash = await hashPassword('correctpassword');
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      passwordHash,
      role: 'USER',
      displayName: 'Test User',
      emailVerified: true,
      orgMembers: [{ org: { slug: 'cortex' } }],
    });
    mockPrisma.refreshToken.create.mockResolvedValue({});

    await POST(createMockRequest({ email: 'user@example.com', password: 'correctpassword' }));
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'login.success',
          outcome: 'success',
          actorUserId: 'user-1',
        }),
      }),
    );
  });

  it('returns 401 for wrong password', async () => {
    const passwordHash = await hashPassword('correctpassword');
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      passwordHash,
      role: 'USER',
      displayName: 'User',
      emailVerified: true,
    });

    const res = await POST(
      createMockRequest({ email: 'user@example.com', password: 'wrongpassword' }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 for password > 72 chars', async () => {
    const res = await POST(
      createMockRequest({ email: 'test@example.com', password: 'a'.repeat(73) }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 200 with tokens and a Nexus postLoginTarget for valid single-org credentials', async () => {
    const passwordHash = await hashPassword('correctpassword');
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      passwordHash,
      role: 'USER',
      displayName: 'Test User',
      emailVerified: true,
      orgMembers: [{ org: { slug: 'cortex' } }],
    });
    mockPrisma.refreshToken.create.mockResolvedValue({});

    const res = await POST(
      createMockRequest({ email: 'user@example.com', password: 'correctpassword' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accessToken).toBeDefined();
    expect(body.user.id).toBe('user-1');
    expect(body.user.role).toBe('USER');
    expect(body.postLoginTarget).toBe('https://cortex.dev.ctxhost.com/');
  });

  it('uses a safe redirectUri as the postLoginTarget', async () => {
    const passwordHash = await hashPassword('correctpassword');
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      passwordHash,
      role: 'USER',
      displayName: 'Test User',
      emailVerified: true,
      orgMembers: [{ org: { slug: 'cortex' } }],
    });
    mockPrisma.refreshToken.create.mockResolvedValue({});

    const res = await POST(
      createMockRequest({
        email: 'user@example.com',
        password: 'correctpassword',
        redirectUri: 'https://plexus.dev.ctxhost.com/health',
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      postLoginTarget: 'https://plexus.dev.ctxhost.com/health',
    });
  });

  it('preserves client context when branded users fall back to account', async () => {
    const passwordHash = await hashPassword('correctpassword');
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      passwordHash,
      role: 'USER',
      displayName: 'Test User',
      emailVerified: true,
      orgMembers: [],
    });
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue({
      clientId: 'tradepost-web',
      displayName: 'CCG Tradepost',
      brandName: 'CCG Tradepost',
      brandTagline: 'Track your collection',
      brandLogoUrl: null,
      brandPrimaryColor: '#d6a84f',
      authProviders: ['google'],
      signupMode: 'waitlist',
      enabled: true,
    });
    mockPrisma.refreshToken.create.mockResolvedValue({});

    const res = await POST(
      createMockRequest({
        email: 'user@example.com',
        password: 'correctpassword',
        clientId: 'tradepost-web',
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      postLoginTarget: '/account?client_id=tradepost-web',
    });
  });

  it('does not send Cite password sign-in to a globally allowed Tradepost target', async () => {
    process.env.ENGRAM_URL = 'https://login.ctxhost.com';
    process.env.ENGRAM_ALLOWED_HOSTS = 'login.ctxhost.com,auth.citethemove.com';
    process.env.NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING = 'https://ccgtradepost.com';
    const passwordHash = await hashPassword('correctpassword');
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1', email: 'user@example.com', passwordHash, role: 'USER',
      displayName: 'Test User', emailVerified: true, orgMembers: [],
    });
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue({
      clientId: 'axon-web', displayName: 'Cite the Move', brandName: 'Cite the Move',
      brandTagline: null, brandLogoUrl: null, brandPrimaryColor: null,
      authProviders: ['google'], signupMode: 'waitlist', enabled: true, redirectUris: [],
    });
    mockPrisma.refreshToken.create.mockResolvedValue({});

    const res = await POST(createMockRequest({
      email: 'user@example.com', password: 'correctpassword',
      redirectUri: 'https://ccgtradepost.com/account',
    }, { host: 'auth.citethemove.com' }));

    await expect(res.json()).resolves.toMatchObject({
      postLoginTarget: '/account?client_id=axon-web',
    });
  });

  it('keeps Cite password sign-in on account instead of the platform-admin default target', async () => {
    process.env.ENGRAM_URL = 'https://login.ctxhost.com';
    process.env.ENGRAM_ALLOWED_HOSTS = 'login.ctxhost.com,auth.citethemove.com';
    const passwordHash = await hashPassword('correctpassword');
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1', email: 'user@example.com', passwordHash, role: 'SUPERADMIN',
      displayName: 'Test User', emailVerified: true, orgMembers: [],
    });
    mockPrisma.refreshToken.create.mockResolvedValue({});

    const res = await POST(createMockRequest({
      email: 'user@example.com', password: 'correctpassword',
    }, { host: 'auth.citethemove.com' }));

    await expect(res.json()).resolves.toMatchObject({
      postLoginTarget: '/account?client_id=axon-web',
    });
  });

  it('ignores an unsafe redirectUri and falls back to the role/org target', async () => {
    const passwordHash = await hashPassword('correctpassword');
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      passwordHash,
      role: 'USER',
      displayName: 'Test User',
      emailVerified: true,
      orgMembers: [{ org: { slug: 'cortex' } }],
    });
    mockPrisma.refreshToken.create.mockResolvedValue({});

    const res = await POST(
      createMockRequest({
        email: 'user@example.com',
        password: 'correctpassword',
        redirectUri: 'https://dashboard.rapidagent.dev:8443/',
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      postLoginTarget: 'https://cortex.dev.ctxhost.com/',
    });
  });

  it('locks an account after 5 failed attempts (429 + Retry-After)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    for (let i = 0; i < 5; i++) {
      const res = await POST(
        createMockRequest({ email: 'target@example.com', password: `wrong-${i}` }),
      );
      expect(res.status).toBe(401);
    }

    const blocked = await POST(
      createMockRequest({ email: 'target@example.com', password: 'wrong-6' }),
    );
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);

    // Other accounts are unaffected by the per-account lockout
    const other = await POST(
      createMockRequest({ email: 'other@example.com', password: 'whatever1' }),
    );
    expect(other.status).toBe(401);
  });

  it('clears the failure counter on successful login', async () => {
    const passwordHash = await hashPassword('correctpassword');
    const user = {
      id: 'user-1',
      email: 'user@example.com',
      passwordHash,
      role: 'USER',
      displayName: 'Test User',
      emailVerified: true,
      orgMembers: [{ org: { slug: 'cortex' } }],
    };
    mockPrisma.user.findUnique.mockResolvedValue(user);
    mockPrisma.refreshToken.create.mockResolvedValue({});

    // 4 failures, then success — counter resets, so 2 more failures don't lock
    for (let i = 0; i < 4; i++) {
      const res = await POST(
        createMockRequest({ email: 'user@example.com', password: 'wrong' }),
      );
      expect(res.status).toBe(401);
    }
    const ok = await POST(
      createMockRequest({ email: 'user@example.com', password: 'correctpassword' }),
    );
    expect(ok.status).toBe(200);

    const after = await POST(
      createMockRequest({ email: 'user@example.com', password: 'wrong' }),
    );
    expect(after.status).toBe(401); // not 429
  });

  it('limits login attempts per IP (429 on the 11th in a minute)', async () => {
    // Missing-password requests fail fast but still consume the IP budget
    for (let i = 0; i < 10; i++) {
      const res = await POST(createMockRequest({ email: `u${i}@example.com` }));
      expect(res.status).toBe(401);
    }

    const blocked = await POST(
      createMockRequest({ email: 'u11@example.com', password: 'password1' }),
    );
    expect(blocked.status).toBe(429);
  });

  it('response sets httpOnly cookies', async () => {
    const passwordHash = await hashPassword('correctpassword');
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      passwordHash,
      role: 'USER',
      displayName: 'Test User',
      emailVerified: true,
    });
    mockPrisma.refreshToken.create.mockResolvedValue({});

    const res = await POST(
      createMockRequest({ email: 'user@example.com', password: 'correctpassword' }),
    );
    const setCookieHeaders = res.headers.getSetCookie();
    expect(setCookieHeaders.length).toBeGreaterThanOrEqual(2);
    const accessCookie = setCookieHeaders.find((c: string) => c.includes('engram-access'));
    const refreshCookie = setCookieHeaders.find((c: string) => c.includes('engram-refresh'));
    expect(accessCookie).toContain('HttpOnly');
    expect(refreshCookie).toContain('HttpOnly');
  });

  it('returns 403 for correct password before email verification', async () => {
    const passwordHash = await hashPassword('correctpassword');
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      passwordHash,
      role: 'USER',
      displayName: 'Test User',
      emailVerified: false,
      orgMembers: [],
    });

    const res = await POST(
      createMockRequest({ email: 'user@example.com', password: 'correctpassword' }),
    );
    expect(res.status).toBe(403);
    expect(mockPrisma.refreshToken.create).not.toHaveBeenCalled();
  });
});
