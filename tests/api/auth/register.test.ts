import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

process.env.ENGRAM_JWT_SECRET='test-s...ngth';

const { mockGetEmailIdentityForClient, mockSendEmailRequired, mockValidateSignupEmail } = vi.hoisted(() => ({
  mockGetEmailIdentityForClient: vi.fn(),
  mockSendEmailRequired: vi.fn(),
  mockValidateSignupEmail: vi.fn(),
}));

vi.mock('@/lib/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email')>();
  return {
    ...actual,
    getEmailIdentityForClient: mockGetEmailIdentityForClient,
    sendEmailRequired: mockSendEmailRequired,
  };
});
vi.mock('@/lib/email-hygiene', () => ({
  validateSignupEmail: mockValidateSignupEmail,
}));

import { mockPrisma } from '../../mocks/prisma';
import { _resetRateLimitForTests } from '@/lib/rate-limit';
import { POST } from '@/app/api/auth/register/route';

function createMockRequest(body?: object, headers: Record<string, string> = {}) {
  const request = new Request('https://auth.ccgtradepost.com/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', host: 'auth.ccgtradepost.com', ...headers },
    body: body ? JSON.stringify(body) : JSON.stringify({}),
  });
  return new NextRequest(request);
}

describe('POST /api/auth/register', () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = 'test-resend-key';
    process.env.ENGRAM_RATE_LIMIT_DISABLED = '1';
    _resetRateLimitForTests();
    vi.clearAllMocks();
    Object.values(mockPrisma).forEach((model) => {
      if (model && typeof model === 'object') {
        Object.values(model).forEach((fn) => (fn as any).mockReset?.());
      }
    });
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue(null);
    process.env.ENGRAM_URL = 'https://login.ctxhost.com';
    process.env.ENGRAM_ALLOWED_HOSTS = 'login.ctxhost.com,auth.ccgtradepost.com';
    mockGetEmailIdentityForClient.mockResolvedValue({
      clientId: 'tradepost-web',
      brandName: 'CCG Tradepost',
      fromName: 'CCG Tradepost',
      fromAddress: 'noreply@ctxhost.com',
      from: 'CCG Tradepost <noreply@ctxhost.com>',
      primaryColor: '#2563eb',
      templateTheme: 'tradepost',
      securedByEngram: true,
    });
    mockValidateSignupEmail.mockResolvedValue({ status: 'accepted', reason: null });
    mockPrisma.emailSuppression.findUnique.mockResolvedValue(null);
  });

  it('returns 403 because suite self-service registration is disabled by default', async () => {
    const res = await POST(createMockRequest({
      email: 'new@example.com',
      password: 'correctpassword',
    }));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('disabled');
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    expect(mockPrisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it('rejects a malformed nonempty client id on the Cite host before rate limits or writes', async () => {
    process.env.ENGRAM_ALLOWED_HOSTS = 'login.ctxhost.com,auth.citethemove.com';
    const res = await POST(createMockRequest({
      clientId: 'tradepost-web!',
      email: 'new@example.com',
      password: 'correctpassword',
    }, { host: 'auth.citethemove.com' }));

    expect(res.status).toBe(400);
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    expect(mockSendEmailRequired).not.toHaveBeenCalled();
  });

  it('creates an unverified user and sends a verify_email link for open-mode clients', async () => {
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue({
      clientId: 'tradepost-web',
      displayName: 'Tradepost',
      brandName: 'Tradepost',
      brandTagline: null,
      brandLogoUrl: null,
      brandPrimaryColor: null,
      authProviders: ['google'],
      signupMode: 'open',
      enabled: true,
    });
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.findFirst.mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue({
      id: 'user-1',
      email: 'new@example.com',
    });
    mockPrisma.magicLink.create.mockResolvedValue({});
    mockSendEmailRequired.mockResolvedValue(undefined);

    const res = await POST(createMockRequest({
      clientId: 'tradepost-web',
      email: 'new@example.com',
      displayName: 'New User',
      password: 'correctpassword',
    }));

    expect(res.status).toBe(202);
    expect(mockPrisma.user.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        email: 'new@example.com',
        emailVerified: false,
        passwordHash: expect.any(String),
      }),
    }));
    expect(mockPrisma.magicLink.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'user-1', purpose: 'verify_email' }),
    }));
    expect(mockSendEmailRequired).toHaveBeenCalledWith(expect.objectContaining({
      to: 'new@example.com',
      from: 'CCG Tradepost <noreply@ctxhost.com>',
      subject: 'Verify your CCG Tradepost account',
      text: expect.stringContaining('Verify email: https://auth.ccgtradepost.com/api/auth/verify-email'),
    }));
  });

  it('returns the generic verification response for an existing open-mode account', async () => {
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue({
      clientId: 'tradepost-web',
      displayName: 'Tradepost',
      brandName: 'Tradepost',
      brandTagline: null,
      brandLogoUrl: null,
      brandPrimaryColor: null,
      authProviders: ['google'],
      signupMode: 'open',
      enabled: true,
    });
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
    });

    const res = await POST(createMockRequest({
      clientId: 'tradepost-web',
      email: 'existing@example.com',
      displayName: 'Existing User',
      password: 'correctpassword',
    }));

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      message: 'Check your email to verify your account before signing in.',
    });
    expect(mockValidateSignupEmail).toHaveBeenCalledWith('existing@example.com');
    expect(mockPrisma.emailSuppression.findUnique).toHaveBeenCalledWith({
      where: { email: 'existing@example.com' },
      select: {
        email: true,
        reason: true,
        source: true,
        eventType: true,
        providerMessageId: true,
        updatedAt: true,
      },
    });
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    expect(mockPrisma.magicLink.create).not.toHaveBeenCalled();
    expect(mockSendEmailRequired).not.toHaveBeenCalled();
  });

  it('returns the generic verification response when user creation loses the email uniqueness race', async () => {
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue({
      clientId: 'tradepost-web',
      displayName: 'Tradepost',
      brandName: 'Tradepost',
      brandTagline: null,
      brandLogoUrl: null,
      brandPrimaryColor: null,
      authProviders: ['google'],
      signupMode: 'open',
      enabled: true,
    });
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.findFirst.mockResolvedValue(null);
    mockPrisma.user.create.mockRejectedValue({ code: 'P2002', meta: { target: ['email'] } });

    const res = await POST(createMockRequest({
      clientId: 'tradepost-web',
      email: 'race@example.com',
      displayName: 'Race User',
      password: 'correctpassword',
    }));

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      message: 'Check your email to verify your account before signing in.',
    });
    expect(mockPrisma.magicLink.create).not.toHaveBeenCalled();
    expect(mockSendEmailRequired).not.toHaveBeenCalled();
  });

  it('does not mask username uniqueness races as successful registrations', async () => {
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue({
      clientId: 'tradepost-web',
      displayName: 'Tradepost',
      brandName: 'Tradepost',
      brandTagline: null,
      brandLogoUrl: null,
      brandPrimaryColor: null,
      authProviders: ['google'],
      signupMode: 'open',
      enabled: true,
    });
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.findFirst.mockResolvedValue(null);
    mockPrisma.user.create.mockRejectedValue({ code: 'P2002', meta: { target: ['username'] } });

    const res = await POST(createMockRequest({
      clientId: 'tradepost-web',
      email: 'username-race@example.com',
      displayName: 'Username Race',
      password: 'correctpassword',
    }));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'Registration failed.' });
    expect(mockPrisma.magicLink.create).not.toHaveBeenCalled();
    expect(mockSendEmailRequired).not.toHaveBeenCalled();
  });

  it('does not let attempts from other IPs burn a victim email-specific registration limit', async () => {
    process.env.ENGRAM_RATE_LIMIT_DISABLED = '0';
    _resetRateLimitForTests();
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue({
      clientId: 'tradepost-web',
      displayName: 'Tradepost',
      brandName: 'Tradepost',
      brandTagline: null,
      brandLogoUrl: null,
      brandPrimaryColor: null,
      authProviders: ['google'],
      signupMode: 'open',
      enabled: true,
    });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1' });

    for (let i = 0; i < 6; i += 1) {
      const res = await POST(createMockRequest({
        clientId: 'tradepost-web',
        email: 'victim@example.com',
        password: 'correctpassword',
      }, { 'x-forwarded-for': `198.51.100.${i}` }));
      expect(res.status).toBe(202);
    }

    const owner = await POST(createMockRequest({
      clientId: 'tradepost-web',
      email: 'victim@example.com',
      password: 'correctpassword',
    }, { 'x-forwarded-for': '203.0.113.10' }));

    expect(owner.status).toBe(202);
  });

  it('rate-limits open-mode registration per IP before account lookups', async () => {
    process.env.ENGRAM_RATE_LIMIT_DISABLED = '0';
    _resetRateLimitForTests();
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue({
      clientId: 'tradepost-web',
      displayName: 'Tradepost',
      brandName: 'Tradepost',
      brandTagline: null,
      brandLogoUrl: null,
      brandPrimaryColor: null,
      authProviders: ['google'],
      signupMode: 'open',
      enabled: true,
    });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1' });

    for (let i = 0; i < 10; i += 1) {
      const res = await POST(createMockRequest({
        clientId: 'tradepost-web',
        email: `ip-${i}@example.com`,
        password: 'correctpassword',
      }));
      expect(res.status).toBe(202);
    }

    vi.clearAllMocks();
    const blocked = await POST(createMockRequest({
      clientId: 'tradepost-web',
      email: 'ip-blocked@example.com',
      password: 'correctpassword',
    }));

    expect(blocked.status).toBe(429);
    expect(mockPrisma.nativeAuthClient.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('returns a generic response without creating an account when the email provider key is missing', async () => {
    delete process.env.RESEND_API_KEY;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue({
      clientId: 'tradepost-web',
      displayName: 'Tradepost',
      brandName: 'Tradepost',
      brandTagline: null,
      brandLogoUrl: null,
      brandPrimaryColor: null,
      authProviders: ['google'],
      signupMode: 'open',
      enabled: true,
    });

    const res = await POST(createMockRequest({
      clientId: 'tradepost-web',
      email: 'new@example.com',
      password: 'correctpassword',
    }));

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      message: 'Check your email to verify your account before signing in.',
    });
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith('Self-service registration is missing RESEND_API_KEY; returning generic response.');
    consoleError.mockRestore();
  });

  it('does not create or send verification for a disposable open-mode signup address', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue({
      clientId: 'tradepost-web',
      displayName: 'Tradepost',
      brandName: 'Tradepost',
      brandTagline: null,
      brandLogoUrl: null,
      brandPrimaryColor: null,
      authProviders: ['google'],
      signupMode: 'open',
      enabled: true,
    });
    mockValidateSignupEmail.mockResolvedValue({
      status: 'rejected_disposable',
      reason: '1secmail.com is a disposable email domain.',
    });

    const res = await POST(createMockRequest({
      clientId: 'tradepost-web',
      email: 'junk@1secmail.com',
      password: 'correctpassword',
    }));

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      message: 'Check your email to verify your account before signing in.',
    });
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    expect(mockSendEmailRequired).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledWith('Registration email hygiene rejected verification:', expect.objectContaining({
      email: 'junk@1secmail.com',
      status: 'rejected_disposable',
    }));
    consoleWarn.mockRestore();
  });

  it('does not create or send verification for a suppressed open-mode signup address', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockPrisma.nativeAuthClient.findUnique.mockResolvedValue({
      clientId: 'tradepost-web',
      displayName: 'Tradepost',
      brandName: 'Tradepost',
      brandTagline: null,
      brandLogoUrl: null,
      brandPrimaryColor: null,
      authProviders: ['google'],
      signupMode: 'open',
      enabled: true,
    });
    mockPrisma.emailSuppression.findUnique.mockResolvedValue({
      email: 'bounced@example.com',
      reason: 'bounced',
      source: 'resend_webhook',
      eventType: 'email.bounced',
      providerMessageId: 'email-1',
      updatedAt: new Date(),
    });

    const res = await POST(createMockRequest({
      clientId: 'tradepost-web',
      email: 'bounced@example.com',
      password: 'correctpassword',
    }));

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      message: 'Check your email to verify your account before signing in.',
    });
    expect(mockPrisma.emailSuppression.findUnique).toHaveBeenCalledWith({
      where: { email: 'bounced@example.com' },
      select: {
        email: true,
        reason: true,
        source: true,
        eventType: true,
        providerMessageId: true,
        updatedAt: true,
      },
    });
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    expect(mockPrisma.magicLink.create).not.toHaveBeenCalled();
    expect(mockSendEmailRequired).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledWith('Registration email suppression blocked verification:', {
      email: 'bounced@example.com',
      reason: 'bounced',
      eventType: 'email.bounced',
    });
    consoleWarn.mockRestore();
  });
});
