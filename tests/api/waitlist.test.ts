import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockGetEmailIdentityForClient,
  mockGetEmailSuppression,
  mockSendEmailBestEffort,
  mockValidateSignupEmail,
} = vi.hoisted(() => ({
  mockGetEmailIdentityForClient: vi.fn(),
  mockGetEmailSuppression: vi.fn(),
  mockSendEmailBestEffort: vi.fn(),
  mockValidateSignupEmail: vi.fn(),
}));

vi.mock('@/lib/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email')>();
  return {
    ...actual,
    getEmailIdentityForClient: mockGetEmailIdentityForClient,
    sendEmailBestEffort: mockSendEmailBestEffort,
  };
});
vi.mock('@/lib/email-hygiene', () => ({
  validateSignupEmail: mockValidateSignupEmail,
}));
vi.mock('@/lib/email-suppression', () => ({
  getEmailSuppression: mockGetEmailSuppression,
}));

import { mockPrisma } from '../mocks/prisma';
import { POST } from '@/app/api/waitlist/route';
import { _resetRateLimitForTests } from '@/lib/rate-limit';

function createMockRequest(
  body?: object,
  options: { url?: string; headers?: Record<string, string> } = {},
) {
  const request = new Request(options.url || 'http://localhost:3104/api/waitlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: body ? JSON.stringify(body) : JSON.stringify({}),
  });
  return new NextRequest(request);
}

describe('POST /api/waitlist', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    _resetRateLimitForTests();
    vi.clearAllMocks();
    Object.values(mockPrisma).forEach((model) => {
      Object.values(model).forEach((fn) => (fn as any).mockReset());
    });
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
    mockGetEmailSuppression.mockResolvedValue(null);
    mockValidateSignupEmail.mockResolvedValue({ status: 'accepted', reason: null });
  });

  it('returns 400 for missing email', async () => {
    const res = await POST(createMockRequest({ displayName: 'Test User' }));
    expect(res.status).toBe(400);
  });

  it('binds a bare Cite auth-host waitlist request to axon-web and rejects a conflicting client', async () => {
    vi.stubEnv('ENGRAM_ALLOWED_HOSTS', 'auth.citethemove.com');
    const response = await POST(createMockRequest(
      { email: 'new@example.com', clientId: 'tradepost-web' },
      { headers: { host: 'auth.citethemove.com' } },
    ));

    expect(response.status).toBe(400);
    expect(mockPrisma.waitlistRequest.upsert).not.toHaveBeenCalled();
  });

  it('rejects a malformed nonempty client id on the Cite host before writes or mail', async () => {
    vi.stubEnv('ENGRAM_ALLOWED_HOSTS', 'auth.citethemove.com');
    const response = await POST(createMockRequest(
      { email: 'new@example.com', clientId: 'tradepost-web!' },
      { headers: { host: 'auth.citethemove.com' } },
    ));

    expect(response.status).toBe(400);
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.waitlistRequest.upsert).not.toHaveBeenCalled();
    expect(mockSendEmailBestEffort).not.toHaveBeenCalled();
  });

  it('records bare Cite auth-host waitlist requests as axon-web', async () => {
    vi.stubEnv('ENGRAM_ALLOWED_HOSTS', 'auth.citethemove.com');
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.waitlistRequest.upsert.mockResolvedValue({ id: 'waitlist-cite' });

    const response = await POST(createMockRequest(
      { email: 'cite@example.com' },
      { headers: { host: 'auth.citethemove.com' } },
    ));

    expect(response.status).toBe(202);
    expect(mockPrisma.waitlistRequest.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ clientId: 'axon-web' }),
    }));
  });

  it('creates a waitlist request for a valid email', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.waitlistRequest.upsert.mockResolvedValue({
      id: 'waitlist-1',
      email: 'new@example.com',
      displayName: 'New User',
    });

    const res = await POST(
      createMockRequest({
        email: 'new@example.com',
        displayName: 'New User',
      }),
    );

    expect(res.status).toBe(202);
    expect(mockPrisma.waitlistRequest.upsert).toHaveBeenCalledWith({
      where: {
        email: 'new@example.com',
      },
      update: {
        displayName: 'New User',
        emailHygieneStatus: 'accepted',
        emailHygieneReason: null,
        emailHygieneCheckedAt: expect.any(Date),
        confirmationEmailSuppressedAt: null,
        requestCount: { increment: 1 },
        lastRequestedAt: expect.any(Date),
      },
      create: {
        email: 'new@example.com',
        displayName: 'New User',
        clientId: null,
        collectionSizeBracket: null,
        formatsPlayed: [],
        tradepostGoals: [],
        priorityNote: null,
        emailHygieneStatus: 'accepted',
        emailHygieneReason: null,
        emailHygieneCheckedAt: expect.any(Date),
        confirmationEmailSuppressedAt: null,
      },
      select: { id: true },
    });
    expect(mockGetEmailIdentityForClient).toHaveBeenCalledWith(null);
    expect(mockSendEmailBestEffort).toHaveBeenCalledWith(expect.objectContaining({
      to: 'new@example.com',
      from: 'CCG Tradepost <noreply@ctxhost.com>',
      subject: "You're on the CCG Tradepost waitlist",
      text: expect.stringContaining('You do not need to do anything else right now.'),
    }));
  });

  it('increments repeat signups without clearing stored enrichment when the repeat is bare', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.waitlistRequest.upsert.mockResolvedValue({
      id: 'waitlist-1',
      email: 'collector@example.com',
      displayName: 'Collector',
    });

    const res = await POST(
      createMockRequest({
        email: 'collector@example.com',
      }),
    );

    expect(res.status).toBe(202);
    const upsert = mockPrisma.waitlistRequest.upsert.mock.calls[0]?.[0];
    expect(upsert).toEqual(expect.objectContaining({
      where: { email: 'collector@example.com' },
      update: {
        emailHygieneStatus: 'accepted',
        emailHygieneReason: null,
        emailHygieneCheckedAt: expect.any(Date),
        confirmationEmailSuppressedAt: null,
        requestCount: { increment: 1 },
        lastRequestedAt: expect.any(Date),
      },
    }));
    expect(upsert.update).not.toHaveProperty('displayName');
    expect(upsert.update).not.toHaveProperty('collectionSizeBracket');
    expect(upsert.update).not.toHaveProperty('formatsPlayed');
    expect(upsert.update).not.toHaveProperty('tradepostGoals');
    expect(upsert.update).not.toHaveProperty('priorityNote');
  });

  it('updates repeat signup enrichment only when new values are provided', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.waitlistRequest.upsert.mockResolvedValue({
      id: 'waitlist-1',
      email: 'collector@example.com',
      displayName: 'Collector',
    });

    const res = await POST(
      createMockRequest({
        email: 'collector@example.com',
        displayName: 'Collector Updated',
        clientId: 'tradepost-web',
        collectionSizeBracket: '20k-plus',
        formatsPlayed: ['Commander', 'Modern'],
        tradepostGoals: ['Pricing', 'Organization'],
        priorityNote: 'I manage a large collection for events.',
      }),
    );

    expect(res.status).toBe(202);
    expect(mockPrisma.waitlistRequest.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { email: 'collector@example.com' },
      update: {
        clientId: 'tradepost-web',
        displayName: 'Collector Updated',
        collectionSizeBracket: '20k-plus',
        formatsPlayed: ['Commander', 'Modern'],
        tradepostGoals: ['Pricing', 'Organization'],
        priorityNote: 'I manage a large collection for events.',
        emailHygieneStatus: 'accepted',
        emailHygieneReason: null,
        emailHygieneCheckedAt: expect.any(Date),
        confirmationEmailSuppressedAt: null,
        requestCount: { increment: 1 },
        lastRequestedAt: expect.any(Date),
      },
    }));
  });

  it('returns a generic success response without creating duplicates', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.waitlistRequest.upsert.mockResolvedValue({
      id: 'waitlist-1',
      email: 'existing@example.com',
      displayName: 'Existing User',
    });

    const res = await POST(
      createMockRequest({
        email: 'existing@example.com',
        displayName: 'Existing User',
      }),
    );

    expect(res.status).toBe(202);
    expect(mockPrisma.waitlistRequest.create).not.toHaveBeenCalled();
  });

  it('returns the same success response for an already approved user', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'member@example.com',
    });

    const res = await POST(
      createMockRequest({
        email: 'member@example.com',
        displayName: 'Existing Member',
      }),
    );

    expect(res.status).toBe(202);
    expect(mockPrisma.waitlistRequest.upsert).not.toHaveBeenCalled();
    expect(mockSendEmailBestEffort).not.toHaveBeenCalled();
  });

  it('sends a branded confirmation for configured client waitlist requests', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.waitlistRequest.upsert.mockResolvedValue({
      id: 'waitlist-1',
      email: 'new@example.com',
      displayName: 'New User',
      clientId: 'tradepost-web',
    });

    const res = await POST(
      createMockRequest({
        email: 'new@example.com',
        displayName: 'New User',
        clientId: 'tradepost-web',
      }),
    );

    expect(res.status).toBe(202);
    expect(mockGetEmailIdentityForClient).toHaveBeenCalledWith('tradepost-web');
    expect(mockSendEmailBestEffort).toHaveBeenCalledWith(expect.objectContaining({
      from: 'CCG Tradepost <noreply@ctxhost.com>',
      subject: "You're on the CCG Tradepost waitlist",
      html: expect.stringContaining('CCG Tradepost sign-in is secured by Engram'),
    }));
  });

  it('uses the allowed request origin for waitlist email when ENGRAM_URL is missing in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ENGRAM_URL', '');
    vi.stubEnv('ENGRAM_ALLOWED_HOSTS', 'login.ctxhost.com');
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.waitlistRequest.upsert.mockResolvedValue({
      id: 'waitlist-1',
      email: 'new@example.com',
      displayName: 'New User',
    });

    const res = await POST(
      createMockRequest(
        {
          email: 'new@example.com',
          displayName: 'New User',
        },
        {
          url: 'https://login.ctxhost.com/api/waitlist',
          headers: { host: 'login.ctxhost.com' },
        },
      ),
    );

    expect(res.status).toBe(202);
    expect(mockSendEmailBestEffort).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Visit the sign-in page: https://login.ctxhost.com'),
    }));
  });

  it('keeps the on-prem auth port in the waitlist email CTA', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ENGRAM_URL', 'https://engram.rapidagent.dev:8443');
    vi.stubEnv('ENGRAM_ALLOWED_HOSTS', 'login.rapidagent.dev:8443');
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.waitlistRequest.upsert.mockResolvedValue({
      id: 'waitlist-1',
      email: 'new@example.com',
      displayName: 'New User',
    });

    const res = await POST(
      createMockRequest(
        {
          email: 'new@example.com',
          displayName: 'New User',
        },
        {
          url: 'https://login.rapidagent.dev:8443/api/waitlist',
          headers: { host: 'login.rapidagent.dev:8443' },
        },
      ),
    );

    expect(res.status).toBe(202);
    expect(mockSendEmailBestEffort).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Visit the sign-in page: https://login.rapidagent.dev:8443'),
    }));
  });

  it('keeps disposable-domain waitlist responses generic and visible without sending mail', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockValidateSignupEmail.mockResolvedValue({
      status: 'rejected_disposable',
      reason: '1secmail.com is a disposable email domain.',
    });
    mockPrisma.waitlistRequest.upsert.mockResolvedValue({
      id: 'waitlist-1',
      email: 'junk@1secmail.com',
    });

    const res = await POST(
      createMockRequest({
        email: 'junk@1secmail.com',
        displayName: 'Junk User',
      }),
    );

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      message: 'Thanks — we received your waitlist request.',
    });
    expect(mockPrisma.waitlistRequest.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        emailHygieneStatus: 'rejected_disposable',
        emailHygieneReason: '1secmail.com is a disposable email domain.',
        confirmationEmailSuppressedAt: expect.any(Date),
      }),
      create: expect.objectContaining({
        emailHygieneStatus: 'rejected_disposable',
        emailHygieneReason: '1secmail.com is a disposable email domain.',
        confirmationEmailSuppressedAt: expect.any(Date),
      }),
    }));
    expect(mockSendEmailBestEffort).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledWith('Waitlist email hygiene rejected confirmation:', expect.objectContaining({
      email: 'junk@1secmail.com',
      status: 'rejected_disposable',
    }));
    consoleWarn.mockRestore();
  });

  it('marks suppressed waitlist confirmations visibly instead of silently claiming a send', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.waitlistRequest.upsert.mockResolvedValue({
      id: 'waitlist-1',
      email: 'bad@example.com',
    });
    mockPrisma.waitlistRequest.update.mockResolvedValue({});
    mockGetEmailSuppression.mockResolvedValue({
      email: 'bad@example.com',
      reason: 'bounced',
      source: 'resend_webhook',
      eventType: 'email.bounced',
      providerMessageId: 'email-1',
      updatedAt: new Date('2026-07-14T00:00:00.000Z'),
    });

    const res = await POST(
      createMockRequest({
        email: 'bad@example.com',
        displayName: 'Bad User',
      }),
    );

    expect(res.status).toBe(202);
    expect(mockPrisma.waitlistRequest.update).toHaveBeenCalledWith({
      where: { id: 'waitlist-1' },
      data: expect.objectContaining({
        emailHygieneStatus: 'suppressed',
        emailHygieneReason: 'bounced via email.bounced',
        confirmationEmailSuppressedAt: expect.any(Date),
      }),
    });
    expect(mockSendEmailBestEffort).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledWith('Waitlist confirmation suppressed:', expect.objectContaining({
      email: 'bad@example.com',
      reason: 'bounced',
    }));
    consoleWarn.mockRestore();
  });

  it('logs the underlying error before returning a generic 500', async () => {
    const error = new Error('missing waitlist table');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.waitlistRequest.upsert.mockRejectedValue(error);

    const res = await POST(
      createMockRequest({
        email: 'new@example.com',
        displayName: 'New User',
      }),
    );

    await expect(res.json()).resolves.toEqual({ error: 'Internal server error' });
    expect(res.status).toBe(500);
    expect(consoleError).toHaveBeenCalledWith('Waitlist request failed:', error);

    consoleError.mockRestore();
  });
});
