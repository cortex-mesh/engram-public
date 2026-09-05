import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

process.env.ENGRAM_URL = 'https://engram.rapidagent.dev:8443';
process.env.ENGRAM_ALLOWED_HOSTS = '';

const {
  mockCreateMagicLink,
  mockEmailSuppressionFindUnique,
  mockSendEmail,
  mockFindUser,
  mockFindNativeClient,
  MockResend,
} = vi.hoisted(() => {
  const mockSendEmail = vi.fn();
  class MockResend {
    emails = { send: mockSendEmail };
    constructor() {}
  }
  return {
    mockCreateMagicLink: vi.fn(),
    mockSendEmail,
    mockEmailSuppressionFindUnique: vi.fn(),
    mockFindUser: vi.fn(),
    mockFindNativeClient: vi.fn(),
    MockResend,
  };
});

vi.mock('@/lib/db/magic-links', () => ({
  createMagicLink: mockCreateMagicLink,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: mockFindUser },
    nativeAuthClient: { findUnique: mockFindNativeClient },
    emailSuppression: { findUnique: mockEmailSuppressionFindUnique },
    magicLink: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock('resend', () => ({ Resend: MockResend }));

import { _resetRateLimitForTests } from '@/lib/rate-limit';
import { POST } from '@/app/api/auth/magic-link/route';

function makeRequest(body: object, headers: Record<string, string> = {}) {
  return new NextRequest(new Request('https://engram.rapidagent.dev:8443/api/auth/magic-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }));
}

describe('POST /api/auth/magic-link', () => {
  beforeEach(() => {
    _resetRateLimitForTests();
    vi.clearAllMocks();
    process.env.RESEND_API_KEY='***';
    process.env.EMAIL_FROM = 'Hosted Auth <sender@example.com>';
    mockFindUser.mockResolvedValue({ id: 'user-1', email: 'roland@rapidagent.dev' });
    mockFindNativeClient.mockResolvedValue(null);
    mockEmailSuppressionFindUnique.mockResolvedValue(null);
    mockCreateMagicLink.mockResolvedValue({ token: 'magic-token' });
    process.env.ENGRAM_URL = 'https://engram.rapidagent.dev:8443';
    process.env.ENGRAM_ALLOWED_HOSTS = '';
  });

  it('uses EMAIL_FROM as the sender when configured', async () => {
    const res = await POST(makeRequest({
      email: 'roland@rapidagent.dev',
    }));

    expect(res.status).toBe(200);
    const payload = mockSendEmail.mock.calls[0][0];
    expect(payload.from).toBe('Hosted Auth <sender@example.com>');
  });

  it('rejects a conflicting client on the Cite host before user lookup or token issuance', async () => {
    process.env.ENGRAM_ALLOWED_HOSTS = 'auth.citethemove.com';
    const response = await POST(makeRequest(
      { email: 'roland@rapidagent.dev', clientId: 'tradepost-web' },
      { host: 'auth.citethemove.com' },
    ));

    expect(response.status).toBe(400);
    expect(mockFindUser).not.toHaveBeenCalled();
    expect(mockCreateMagicLink).not.toHaveBeenCalled();
  });

  it('rejects conflicting direct and nested client ids on the Cite host before issuing a link', async () => {
    process.env.ENGRAM_ALLOWED_HOSTS = 'auth.citethemove.com';
    const response = await POST(makeRequest(
      {
        email: 'roland@rapidagent.dev',
        clientId: 'axon-web',
        redirectUri: '/authorize?client_id=tradepost-web',
      },
      { host: 'auth.citethemove.com' },
    ));

    expect(response.status).toBe(400);
    expect(mockFindUser).not.toHaveBeenCalled();
    expect(mockCreateMagicLink).not.toHaveBeenCalled();
  });

  it('falls back to the CORTEX sender when EMAIL_FROM is blank', async () => {
    process.env.EMAIL_FROM = '   ';

    const res = await POST(makeRequest({
      email: 'roland@rapidagent.dev',
    }));

    expect(res.status).toBe(200);
    const payload = mockSendEmail.mock.calls[0][0];
    expect(payload.from).toBe('CORTEX <noreply@ctxhost.com>');
  });

  it('brands magic link email content as CORTEX instead of Engram', async () => {
    process.env.EMAIL_FROM = '   ';

    const res = await POST(makeRequest({
      email: 'roland@rapidagent.dev',
    }));

    expect(res.status).toBe(200);
    const payload = mockSendEmail.mock.calls[0][0];
    expect(payload.subject).toBe('Sign in to CORTEX');
    expect(payload.html).toContain('Sign in to CORTEX');
    expect(payload.html).toContain('CORTEX sign-in is secured by Engram');
    expect(payload.text).toContain('Sign in to CORTEX');
  });

  it('includes redirect_uri in the verification email when provided', async () => {
    const res = await POST(makeRequest({
      email: 'roland@rapidagent.dev',
      redirectUri: 'https://plexus.dev.ctxhost.com/chat',
    }));

    expect(res.status).toBe(200);
    const payload = mockSendEmail.mock.calls[0][0];
    expect(payload.html).toContain(
      encodeURIComponent('https://plexus.dev.ctxhost.com/chat'),
    );
  });

  it('does not put a globally allowed Tradepost target into a Cite magic link', async () => {
    process.env.ENGRAM_URL = 'https://login.ctxhost.com';
    process.env.ENGRAM_ALLOWED_HOSTS = 'login.ctxhost.com,auth.citethemove.com';
    mockFindNativeClient.mockResolvedValue({
      clientId: 'axon-web', displayName: 'Cite the Move', brandName: 'Cite the Move',
      emailFromName: null, emailFromAddress: null, emailTemplateTheme: null,
      enabled: true, redirectUris: [],
    });

    const res = await POST(makeRequest({
      email: 'roland@rapidagent.dev', redirectUri: 'https://ccgtradepost.com/account',
    }, { host: 'auth.citethemove.com' }));

    expect(res.status).toBe(200);
    expect(mockSendEmail.mock.calls[0][0].text).not.toContain('redirect_uri=');
  });

  it('omits a malformed non-string redirectUri without failing after token issuance', async () => {
    const res = await POST(makeRequest({
      email: 'roland@rapidagent.dev',
      redirectUri: {},
    }));

    expect(res.status).toBe(200);
    expect(mockCreateMagicLink).toHaveBeenCalledOnce();
    expect(mockSendEmail.mock.calls[0][0].text).not.toContain('redirect_uri=');
  });

  it('brands magic link email from the requested client id', async () => {
    mockFindNativeClient.mockResolvedValue({
      clientId: 'tradepost-web',
      displayName: 'CCG Tradepost',
      brandName: 'CCG Tradepost',
      brandPrimaryColor: '#0f766e',
      emailFromName: 'CCG Tradepost',
      emailFromAddress: 'noreply@ccgtradepost.com',
      emailTemplateTheme: 'tradepost',
      enabled: true,
    });

    const res = await POST(makeRequest({
      email: 'roland@rapidagent.dev',
      clientId: 'tradepost-web',
    }));

    expect(res.status).toBe(200);
    const payload = mockSendEmail.mock.calls[0][0];
    expect(payload.from).toBe('CCG Tradepost <sender@example.com>');
    expect(payload.subject).toBe('Sign in to CCG Tradepost');
    expect(payload.text).toContain('CCG Tradepost sign-in is secured by Engram');
    expect(payload.text).toContain('client_id=tradepost-web');
  });

  it('uses the allowlisted branded host for Tradepost magic links', async () => {
    process.env.ENGRAM_URL = 'https://login.ctxhost.com';
    process.env.ENGRAM_ALLOWED_HOSTS = 'login.ctxhost.com,auth.ccgtradepost.com';

    const res = await POST(makeRequest(
      {
        email: 'roland@rapidagent.dev',
        clientId: 'tradepost-web',
      },
      { host: 'auth.ccgtradepost.com' },
    ));

    expect(res.status).toBe(200);
    const payload = mockSendEmail.mock.calls[0][0];
    expect(payload.text).toContain(
      'https://auth.ccgtradepost.com/api/auth/magic-link/verify?token=magic-token',
    );
    expect(payload.text).not.toContain('login.ctxhost.com');
  });

  it.each(['evil.example.com', 'auth.ccgtradepost.com.evil.com'])(
    'keeps the allowlisted public Host for magic links despite spoofed forwarded host %s',
    async (host) => {
      process.env.ENGRAM_URL = 'https://login.ctxhost.com';
      process.env.ENGRAM_ALLOWED_HOSTS = 'login.ctxhost.com,auth.ccgtradepost.com';

      const res = await POST(makeRequest(
        { email: 'roland@rapidagent.dev', clientId: 'tradepost-web' },
        { host: 'auth.ccgtradepost.com', 'x-forwarded-host': host },
      ));

      expect(res.status).toBe(200);
      const payload = mockSendEmail.mock.calls[0][0];
      expect(payload.text).toContain('https://auth.ccgtradepost.com/api/auth/magic-link/verify');
      expect(payload.text).not.toContain(host);
    },
  );

  it('returns 429 after 3 link requests for the same email', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await POST(makeRequest({ email: 'roland@rapidagent.dev' }));
      expect(res.status).toBe(200);
    }

    const blocked = await POST(makeRequest({ email: 'roland@rapidagent.dev' }));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(mockSendEmail).toHaveBeenCalledTimes(3);
  });

  it('returns 429 when one IP requests links for too many emails', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await POST(makeRequest({ email: `user-${i}@example.com` }));
      expect(res.status).toBe(200);
    }

    const blocked = await POST(makeRequest({ email: 'user-11@example.com' }));
    expect(blocked.status).toBe(429);
  });
});
