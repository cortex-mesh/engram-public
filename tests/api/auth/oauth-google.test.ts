import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

process.env.ENGRAM_URL = 'https://login.dev.ctxhost.com';
process.env.ENGRAM_JWT_SECRET = 'test-secret-long-enough';
process.env.ENGRAM_GOOGLE_CLIENT_ID = 'google-client';
process.env.ENGRAM_GOOGLE_CLIENT_SECRET = 'google-secret';

const { mockExchangeGoogleCode, mockGetGoogleUser, mockFindOrCreateOAuthUser, mockPrismaCreate, mockPrismaUserFindUnique, mockPrismaNativeFindUnique } = vi.hoisted(() => ({
  mockExchangeGoogleCode: vi.fn(),
  mockGetGoogleUser: vi.fn(),
  mockFindOrCreateOAuthUser: vi.fn(),
  mockPrismaCreate: vi.fn(),
  mockPrismaUserFindUnique: vi.fn(),
  mockPrismaNativeFindUnique: vi.fn(),
}));

vi.mock('@/lib/oauth/google', () => ({
  getGoogleAuthUrl: vi.fn((redirectUri: string, state: string) => `https://accounts.google.com/o/oauth2/auth?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`),
  exchangeGoogleCode: mockExchangeGoogleCode,
  getGoogleUser: mockGetGoogleUser,
}));

vi.mock('@/lib/db/oauth-accounts', () => ({
  findOrCreateOAuthUser: mockFindOrCreateOAuthUser,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    refreshToken: {
      create: mockPrismaCreate,
    },
    user: {
      findUnique: mockPrismaUserFindUnique,
    },
    nativeAuthClient: {
      findUnique: mockPrismaNativeFindUnique,
    },
  },
}));

import { GET as StartGoogleOAuth } from '@/app/api/auth/oauth/google/route';
import { GET as GoogleOAuthCallback } from '@/app/api/auth/oauth/google/callback/route';
import { getOAuthCallbackClientPolicy } from '@/lib/auth-client-config';

function makeRequest(url: string, cookie?: string, headers: Record<string, string> = {}) {
  return new NextRequest(new Request(url, {
    headers: { ...headers, ...(cookie ? { cookie } : {}) },
  }));
}

function expectOAuthContextCleared(response: Response) {
  for (const name of ['oauth-state', 'oauth-provider', 'oauth-redirect-uri', 'oauth-client-id']) {
    expect(response.headers.getSetCookie()).toContainEqual(
      expect.stringContaining(`${name}=; Path=/; Max-Age=0`),
    );
  }
}

describe('Google OAuth redirect preservation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENGRAM_URL = 'https://login.dev.ctxhost.com';
    process.env.ENGRAM_ALLOWED_HOSTS = '';
  });

  it('stores redirect_uri when starting Google OAuth', async () => {
    const res = await StartGoogleOAuth(
      makeRequest('https://login.dev.ctxhost.com/api/auth/oauth/google?redirect_uri=https%3A%2F%2Fplexus.dev.ctxhost.com%2Fchat'),
    );

    const cookies = res.headers.getSetCookie();
    const redirectCookie = cookies.find((c) => c.includes('oauth-redirect-uri='));
    expect(redirectCookie).toBeDefined();
    expect(decodeURIComponent(redirectCookie!)).toContain('https://plexus.dev.ctxhost.com/chat');
    expect(cookies.some((cookie) => cookie.includes('oauth-provider=google'))).toBe(true);
    expect(cookies).toContainEqual(expect.stringMatching(/^oauth-state=(?!;).+; Path=\/; Expires=.*; Max-Age=600; HttpOnly; SameSite=lax$/));
  });

  it('stores live state and client cookies for a direct Cite Google start', async () => {
    process.env.ENGRAM_URL = 'https://login.ctxhost.com';
    process.env.ENGRAM_ALLOWED_HOSTS = 'login.ctxhost.com,auth.citethemove.com';
    mockPrismaNativeFindUnique.mockResolvedValue({
      clientId: 'axon-web', enabled: true, authProviders: ['google'], signupMode: 'waitlist',
      redirectUris: [{ id: 'redirect-1' }],
    });

    const res = await StartGoogleOAuth(makeRequest(
      'https://auth.citethemove.com/api/auth/oauth/google?redirect_uri=https%3A%2F%2Fapp.citethemove.com%2Fauth%2Fcallback',
      undefined,
      { host: 'auth.citethemove.com' },
    ));

    const cookies = res.headers.getSetCookie();
    expect(cookies).toContainEqual(expect.stringMatching(/^oauth-state=(?!;).+; Path=\/; Expires=.*; Max-Age=600; HttpOnly; SameSite=lax$/));
    expect(cookies).toContainEqual(expect.stringMatching(/^oauth-client-id=axon-web; Path=\/; Expires=.*; Max-Age=600; HttpOnly; SameSite=lax$/));
    expect(cookies).toContainEqual(expect.stringContaining('oauth-redirect-uri=https%3A%2F%2Fapp.citethemove.com%2Fauth%2Fcallback'));
  });

  it('clears stale redirect and client context when a sequential Google flow omits both', async () => {
    mockPrismaNativeFindUnique.mockResolvedValue({
      clientId: 'axon-web', displayName: 'Cite the Move', brandName: 'Cite the Move',
      brandTagline: null, brandLogoUrl: null, brandPrimaryColor: null,
      authProviders: ['google'], signupMode: 'waitlist', enabled: true,
    });
    await StartGoogleOAuth(makeRequest(
      'https://login.dev.ctxhost.com/api/auth/oauth/google?client_id=axon-web&redirect_uri=https%3A%2F%2Fplexus.dev.ctxhost.com%2Fchat',
    ));

    const res = await StartGoogleOAuth(makeRequest(
      'https://login.dev.ctxhost.com/api/auth/oauth/google',
      'oauth-state=old; oauth-provider=google; oauth-client-id=axon-web; oauth-redirect-uri=' + encodeURIComponent('https://plexus.dev.ctxhost.com/chat'),
    ));
    const cookies = res.headers.getSetCookie();

    expect(cookies).toContainEqual(expect.stringContaining('oauth-redirect-uri=; Path=/; Max-Age=0'));
    expect(cookies).toContainEqual(expect.stringContaining('oauth-client-id=; Path=/; Max-Age=0'));
    expect(cookies).toContainEqual(expect.stringContaining('oauth-provider=google'));
  });

  it('clears every OAuth context cookie on a terminal Google state error', async () => {
    const res = await GoogleOAuthCallback(makeRequest(
      'https://login.dev.ctxhost.com/api/auth/oauth/google/callback?code=abc&state=wrong-state',
      'oauth-state=test-state; oauth-provider=google; oauth-client-id=axon-web; oauth-redirect-uri=https%3A%2F%2Fplexus.dev.ctxhost.com%2Fchat',
    ));

    expectOAuthContextCleared(res);
  });

  it('clears every OAuth context cookie when Google OAuth is unconfigured', async () => {
    const clientId = process.env.ENGRAM_GOOGLE_CLIENT_ID;
    delete process.env.ENGRAM_GOOGLE_CLIENT_ID;
    try {
      const res = await StartGoogleOAuth(makeRequest(
        'https://login.dev.ctxhost.com/api/auth/oauth/google',
        'oauth-state=old; oauth-provider=github; oauth-client-id=axon-web; oauth-redirect-uri=https%3A%2F%2Fplexus.dev.ctxhost.com%2Fchat',
      ));

      expect(res.status).toBe(501);
      expectOAuthContextCleared(res);
    } finally {
      if (clientId === undefined) delete process.env.ENGRAM_GOOGLE_CLIENT_ID;
      else process.env.ENGRAM_GOOGLE_CLIENT_ID = clientId;
    }
  });

  it('clears every OAuth context cookie when Cite rejects a Google client', async () => {
    process.env.ENGRAM_ALLOWED_HOSTS = 'auth.citethemove.com';

    const res = await StartGoogleOAuth(makeRequest(
      'https://auth.citethemove.com/api/auth/oauth/google?client_id=tradepost-web',
      'oauth-state=old; oauth-provider=github; oauth-client-id=axon-web; oauth-redirect-uri=https%3A%2F%2Fplexus.dev.ctxhost.com%2Fchat',
      { host: 'auth.citethemove.com' },
    ));

    expect(res.status).toBe(400);
    expectOAuthContextCleared(res);
  });

  it('clears every OAuth context cookie when Google is disabled for a client', async () => {
    mockPrismaNativeFindUnique.mockResolvedValue({
      clientId: 'axon-web', displayName: 'Cite the Move', brandName: 'Cite the Move',
      brandTagline: null, brandLogoUrl: null, brandPrimaryColor: null,
      authProviders: ['github'], signupMode: 'waitlist', enabled: true,
    });

    const res = await StartGoogleOAuth(makeRequest(
      'https://login.dev.ctxhost.com/api/auth/oauth/google?client_id=axon-web',
      'oauth-state=old; oauth-provider=github; oauth-client-id=axon-web; oauth-redirect-uri=https%3A%2F%2Fplexus.dev.ctxhost.com%2Fchat',
    ));

    expect(res.status).toBe(403);
    expectOAuthContextCleared(res);
  });

  it.each([
    ['missing', null],
    ['disabled', { clientId: 'axon-web', enabled: false, authProviders: ['google'] }],
    ['empty provider list', { clientId: 'axon-web', enabled: true, authProviders: [] }],
    ['invalid provider list', { clientId: 'axon-web', enabled: true, authProviders: ['saml'] }],
  ])('fails closed and clears every context cookie when Google OAuth start has a %s axon-web configuration', async (_label, client) => {
    mockPrismaNativeFindUnique.mockResolvedValue(client);

    const res = await StartGoogleOAuth(makeRequest(
      'https://login.dev.ctxhost.com/api/auth/oauth/google?client_id=axon-web',
      'oauth-state=old; oauth-provider=github; oauth-client-id=axon-web; oauth-redirect-uri=https%3A%2F%2Fplexus.dev.ctxhost.com%2Fchat',
    ));

    expect(res.status).toBe(403);
    expect(res.headers.get('location')).toBeNull();
    expectOAuthContextCleared(res);
  });

  it('fails closed and clears every context cookie when Google OAuth start cannot load its client', async () => {
    process.env.ENGRAM_ALLOWED_HOSTS = 'auth.citethemove.com';
    mockPrismaNativeFindUnique.mockRejectedValue(new Error('database unavailable'));

    const res = await StartGoogleOAuth(makeRequest(
      'https://auth.citethemove.com/api/auth/oauth/google',
      'oauth-state=old; oauth-provider=github; oauth-client-id=axon-web; oauth-redirect-uri=https%3A%2F%2Fplexus.dev.ctxhost.com%2Fchat',
      { host: 'auth.citethemove.com' },
    ));

    expect(res.status).toBe(503);
    expectOAuthContextCleared(res);
  });

  it('fails closed and clears every context cookie when Google callback policy lookup rejects', async () => {
    process.env.ENGRAM_ALLOWED_HOSTS = 'auth.citethemove.com';
    mockPrismaNativeFindUnique.mockRejectedValue(new Error('database unavailable'));

    const res = await GoogleOAuthCallback(makeRequest(
      'https://auth.citethemove.com/api/auth/oauth/google/callback?code=abc&state=test-state',
      'oauth-state=test-state; oauth-provider=google; oauth-client-id=axon-web; oauth-redirect-uri=https%3A%2F%2Fplexus.dev.ctxhost.com%2Fchat',
      { host: 'auth.citethemove.com' },
    ));

    expect(res.headers.get('location')).toContain('error=oauth_invalid_client');
    expectOAuthContextCleared(res);
    expect(mockExchangeGoogleCode).not.toHaveBeenCalled();
  });

  it('rejects a provider-mismatched or missing state cookie before exchanging a Google code', async () => {
    for (const cookie of ['oauth-state=test-state; oauth-provider=github', 'oauth-state=test-state']) {
      const res = await GoogleOAuthCallback(makeRequest(
        'https://login.dev.ctxhost.com/api/auth/oauth/google/callback?code=abc&state=test-state',
        cookie,
      ));
      expect(res.headers.get('location')).toContain('error=oauth_invalid_state');
    }
    expect(mockExchangeGoogleCode).not.toHaveBeenCalled();
  });

  it('rejects a provider disabled for the resolved client before exchanging a Google code', async () => {
    mockPrismaNativeFindUnique.mockResolvedValue({
      clientId: 'axon-web',
      displayName: 'Cite the Move',
      brandName: 'Cite the Move',
      brandTagline: null,
      brandLogoUrl: null,
      brandPrimaryColor: null,
      authProviders: ['github'],
      signupMode: 'waitlist',
      enabled: true,
    });

    const res = await GoogleOAuthCallback(makeRequest(
      'https://login.dev.ctxhost.com/api/auth/oauth/google/callback?code=abc&state=test-state',
      'oauth-state=test-state; oauth-provider=google; oauth-client-id=axon-web',
    ));

    expect(res.headers.get('location')).toContain('error=oauth_invalid_client');
    expect(mockExchangeGoogleCode).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['disabled', { clientId: 'axon-web', enabled: false, authProviders: ['google'] }],
    ['empty policy', { clientId: 'axon-web', enabled: true, authProviders: [] }],
    ['all-invalid policy', { clientId: 'axon-web', enabled: true, authProviders: ['saml'] }],
  ])('rejects a %s native client policy before Google provider exchange or account effects', async (_label, client) => {
    mockPrismaNativeFindUnique.mockResolvedValue(client);

    const res = await GoogleOAuthCallback(makeRequest(
      'https://login.dev.ctxhost.com/api/auth/oauth/google/callback?code=abc&state=test-state',
      'oauth-state=test-state; oauth-provider=google; oauth-client-id=axon-web',
    ));

    expect(res.headers.get('location')).toContain('error=oauth_invalid_client');
    expect(mockExchangeGoogleCode).not.toHaveBeenCalled();
    expect(mockFindOrCreateOAuthUser).not.toHaveBeenCalled();
    expect(mockPrismaCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', []],
    ['all-invalid', ['saml']],
  ])('returns no strict OAuth callback policy for a %s provider list', async (_label, authProviders) => {
    mockPrismaNativeFindUnique.mockResolvedValue({
      clientId: 'axon-web',
      enabled: true,
      authProviders,
      signupMode: 'waitlist',
    });

    await expect(getOAuthCallbackClientPolicy('axon-web')).resolves.toBeNull();
  });

  it('uses the allowlisted branded host for the Google callback URI', async () => {
    process.env.ENGRAM_URL = 'https://login.ctxhost.com';
    process.env.ENGRAM_ALLOWED_HOSTS = 'login.ctxhost.com,auth.ccgtradepost.com';

    const res = await StartGoogleOAuth(
      makeRequest('https://auth.ccgtradepost.com/api/auth/oauth/google', undefined, {
        host: 'auth.ccgtradepost.com',
      }),
    );

    const location = res.headers.get('location')!;
    expect(decodeURIComponent(location)).toContain(
      'redirect_uri=https://auth.ccgtradepost.com/api/auth/oauth/google/callback',
    );
    expect(decodeURIComponent(location)).not.toContain('login.ctxhost.com');
  });

  it('rejects conflicting direct and nested client ids on the Cite host before starting OAuth', async () => {
    process.env.ENGRAM_ALLOWED_HOSTS = 'auth.citethemove.com';

    const res = await StartGoogleOAuth(makeRequest(
      'https://auth.citethemove.com/api/auth/oauth/google?client_id=axon-web&redirect_uri=%2Fauthorize%3Fclient_id%3Dtradepost-web',
      undefined,
      { host: 'auth.citethemove.com' },
    ));

    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('does not store a globally allowed Tradepost target for Cite Google OAuth', async () => {
    process.env.ENGRAM_URL = 'https://login.ctxhost.com';
    process.env.ENGRAM_ALLOWED_HOSTS = 'login.ctxhost.com,auth.citethemove.com';
    process.env.NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING = 'https://ccgtradepost.com';
    mockPrismaNativeFindUnique.mockResolvedValue({
      clientId: 'axon-web', displayName: 'Cite the Move', brandName: 'Cite the Move',
      brandTagline: null, brandLogoUrl: null, brandPrimaryColor: null,
      authProviders: ['google'], signupMode: 'waitlist', enabled: true, redirectUris: [],
    });

    const res = await StartGoogleOAuth(makeRequest(
      'https://auth.citethemove.com/api/auth/oauth/google?redirect_uri=https%3A%2F%2Fccgtradepost.com%2Faccount',
      undefined,
      { host: 'auth.citethemove.com' },
    ));

    expect(res.headers.getSetCookie()).toContainEqual(
      expect.stringContaining('oauth-redirect-uri=; Path=/; Max-Age=0'),
    );
  });

  it.each(['evil.example.com', 'auth.ccgtradepost.com.evil.com'])(
    'keeps the allowlisted public Host when Google OAuth receives spoofed forwarded host %s',
    async (host) => {
      process.env.ENGRAM_URL = 'https://login.ctxhost.com';
      process.env.ENGRAM_ALLOWED_HOSTS = 'login.ctxhost.com,auth.ccgtradepost.com';

      const res = await StartGoogleOAuth(
        makeRequest('https://auth.ccgtradepost.com/api/auth/oauth/google', undefined, {
          host: 'auth.ccgtradepost.com',
          'x-forwarded-host': host,
        }),
      );

      const location = decodeURIComponent(res.headers.get('location')!);
      expect(location).toContain(
        'redirect_uri=https://auth.ccgtradepost.com/api/auth/oauth/google/callback',
      );
      expect(location).not.toContain(host);
    },
  );

  it('redirects to stored redirect_uri after successful Google OAuth callback', async () => {
    mockExchangeGoogleCode.mockResolvedValue({ accessToken: 'google-token' });
    mockGetGoogleUser.mockResolvedValue({
      id: 'google-user-1',
      email: 'roland@rapidagent.dev',
      name: 'Roland',
      picture: 'https://example.com/avatar.png',
    });
    mockFindOrCreateOAuthUser.mockResolvedValue({
      user: { id: 'user-1', role: 'USER' },
      isNewUser: false,
    });
    mockPrismaUserFindUnique.mockResolvedValue({
      id: 'user-1',
      displayName: 'Roland',
      role: 'USER',
      lastOrgId: null,
      orgMembers: [{ org: { id: 'org-1', slug: 'cortex' } }],
    });
    mockPrismaCreate.mockResolvedValue({});

    const res = await GoogleOAuthCallback(
      makeRequest(
        'https://login.dev.ctxhost.com/api/auth/oauth/google/callback?code=abc&state=test-state',
        'oauth-state=test-state; oauth-provider=google; oauth-redirect-uri=' + encodeURIComponent('https://plexus.dev.ctxhost.com/chat'),
      ),
    );

    expect(res.headers.get('location')).toBe('https://plexus.dev.ctxhost.com/chat');
    expectOAuthContextCleared(res);
  });

  it('falls back instead of honoring a disabled Cite callback after Google OAuth', async () => {
    process.env.ENGRAM_URL = 'https://login.ctxhost.com';
    process.env.ENGRAM_ALLOWED_HOSTS = 'login.ctxhost.com,auth.citethemove.com';
    mockPrismaNativeFindUnique.mockResolvedValue({
      clientId: 'axon-web', enabled: true, authProviders: ['google'], signupMode: 'waitlist', redirectUris: [],
    });
    mockExchangeGoogleCode.mockResolvedValue({ accessToken: 'google-token' });
    mockGetGoogleUser.mockResolvedValue({ id: 'google-user-1', email: 'roland@example.com', name: 'Roland' });
    mockFindOrCreateOAuthUser.mockResolvedValue({ user: { id: 'user-1', role: 'USER' }, isNewUser: false });
    mockPrismaUserFindUnique.mockResolvedValue({
      id: 'user-1', displayName: 'Roland', role: 'USER', lastOrgId: null, orgMembers: [],
    });
    mockPrismaCreate.mockResolvedValue({});

    const res = await GoogleOAuthCallback(makeRequest(
      'https://auth.citethemove.com/api/auth/oauth/google/callback?code=abc&state=test-state',
      'oauth-state=test-state; oauth-provider=google; oauth-client-id=axon-web; oauth-redirect-uri=' + encodeURIComponent('https://app.citethemove.com/auth/callback'),
      { host: 'auth.citethemove.com' },
    ));

    expect(res.headers.get('location')).toBe('https://auth.citethemove.com/account?client_id=axon-web');
  });

  it('keeps Cite Google OAuth on account instead of the platform-admin default target', async () => {
    process.env.ENGRAM_URL = 'https://login.ctxhost.com';
    process.env.ENGRAM_ALLOWED_HOSTS = 'login.ctxhost.com,auth.citethemove.com';
    mockPrismaNativeFindUnique.mockResolvedValue({
      clientId: 'axon-web', enabled: true, authProviders: ['google'], signupMode: 'waitlist',
    });
    mockExchangeGoogleCode.mockResolvedValue({ accessToken: 'google-token' });
    mockGetGoogleUser.mockResolvedValue({ id: 'google-user-1', email: 'roland@example.com', name: 'Roland' });
    mockFindOrCreateOAuthUser.mockResolvedValue({ user: { id: 'user-1', role: 'SUPERADMIN' }, isNewUser: false });
    mockPrismaUserFindUnique.mockResolvedValue({
      id: 'user-1', displayName: 'Roland', role: 'SUPERADMIN', lastOrgId: null, orgMembers: [],
    });
    mockPrismaCreate.mockResolvedValue({});

    const res = await GoogleOAuthCallback(makeRequest(
      'https://auth.citethemove.com/api/auth/oauth/google/callback?code=abc&state=test-state',
      'oauth-state=test-state; oauth-provider=google; oauth-client-id=axon-web',
      { host: 'auth.citethemove.com' },
    ));

    expect(res.headers.get('location')).toBe('https://auth.citethemove.com/account?client_id=axon-web');
  });

  it('exchanges Google OAuth codes with the allowlisted branded callback URI', async () => {
    process.env.ENGRAM_URL = 'https://login.ctxhost.com';
    process.env.ENGRAM_ALLOWED_HOSTS = 'login.ctxhost.com,auth.ccgtradepost.com';
    mockExchangeGoogleCode.mockResolvedValue({ accessToken: 'google-token' });
    mockGetGoogleUser.mockResolvedValue({
      id: 'google-user-1',
      email: 'roland@rapidagent.dev',
      name: 'Roland',
      picture: 'https://example.com/avatar.png',
    });
    mockFindOrCreateOAuthUser.mockResolvedValue({
      user: { id: 'user-1', role: 'USER' },
      isNewUser: false,
    });
    mockPrismaUserFindUnique.mockResolvedValue({
      id: 'user-1',
      displayName: 'Roland',
      role: 'USER',
      lastOrgId: null,
      orgMembers: [{ org: { id: 'org-1', slug: 'cortex' } }],
    });
    mockPrismaCreate.mockResolvedValue({});

    await GoogleOAuthCallback(
      makeRequest(
        'https://auth.ccgtradepost.com/api/auth/oauth/google/callback?code=abc&state=test-state',
        'oauth-state=test-state; oauth-provider=google',
        { host: 'auth.ccgtradepost.com' },
      ),
    );

    expect(mockExchangeGoogleCode).toHaveBeenCalledWith(
      'abc',
      'https://auth.ccgtradepost.com/api/auth/oauth/google/callback',
    );
  });

  it('rejects duplicate and malformed nested client ids on the Cite callback before exchanging the Google code', async () => {
    process.env.ENGRAM_URL = 'https://login.ctxhost.com';
    process.env.ENGRAM_ALLOWED_HOSTS = 'login.ctxhost.com,auth.citethemove.com';

    const res = await GoogleOAuthCallback(makeRequest(
      'https://auth.citethemove.com/api/auth/oauth/google/callback?code=abc&state=test-state',
      'oauth-state=test-state; oauth-provider=google; oauth-client-id=axon-web; oauth-redirect-uri=' + encodeURIComponent(
        '/authorize?client_id=axon-web&client_id=tradepost-web!',
      ),
      { host: 'auth.citethemove.com' },
    ));

    expect(res.headers.get('location')).toContain('error=oauth_invalid_client');
    expect(mockExchangeGoogleCode).not.toHaveBeenCalled();
    expect(mockFindOrCreateOAuthUser).not.toHaveBeenCalled();
  });

  it('rejects a malformed nested durable continuation on the Cite callback before exchanging the Google code', async () => {
    process.env.ENGRAM_URL = 'https://login.ctxhost.com';
    process.env.ENGRAM_ALLOWED_HOSTS = 'login.ctxhost.com,auth.citethemove.com';

    const res = await GoogleOAuthCallback(makeRequest(
      'https://auth.citethemove.com/api/auth/oauth/google/callback?code=abc&state=test-state',
      'oauth-state=test-state; oauth-provider=google; oauth-client-id=axon-web; oauth-redirect-uri=' + encodeURIComponent('/authorize?rt=not-base64'),
      { host: 'auth.citethemove.com' },
    ));

    expect(res.headers.get('location')).toContain('error=oauth_invalid_client');
    expect(mockExchangeGoogleCode).not.toHaveBeenCalled();
    expect(mockFindOrCreateOAuthUser).not.toHaveBeenCalled();
  });

  it('redirects single-org users to their Nexus tenant host when no redirect_uri is stored', async () => {
    mockExchangeGoogleCode.mockResolvedValue({ accessToken: 'google-token' });
    mockGetGoogleUser.mockResolvedValue({
      id: 'google-user-1',
      email: 'ops@example.com',
      name: 'Roland Parnaso',
      picture: 'https://example.com/avatar.png',
    });
    mockFindOrCreateOAuthUser.mockResolvedValue({
      user: { id: 'user-1', role: 'USER' },
      isNewUser: false,
    });
    mockPrismaUserFindUnique.mockResolvedValue({
      id: 'user-1',
      displayName: 'Roland Parnaso',
      role: 'USER',
      lastOrgId: null,
      orgMembers: [{ org: { id: 'org-1', slug: 'cortex' } }],
    });
    mockPrismaCreate.mockResolvedValue({});

    const res = await GoogleOAuthCallback(
      makeRequest(
        'https://login.dev.ctxhost.com/api/auth/oauth/google/callback?code=abc&state=test-state',
        'oauth-state=test-state; oauth-provider=google',
      ),
    );

    expect(res.headers.get('location')).toBe('https://cortex.dev.ctxhost.com/');
  });

  it('redirects unknown OAuth users to the waitlist page instead of creating an account', async () => {
    mockExchangeGoogleCode.mockResolvedValue({ accessToken: 'google-token' });
    mockGetGoogleUser.mockResolvedValue({
      id: 'google-user-2',
      email: 'newperson@example.com',
      name: 'New Person',
      picture: 'https://example.com/avatar.png',
    });
    mockFindOrCreateOAuthUser.mockResolvedValue(null);

    const res = await GoogleOAuthCallback(
      makeRequest(
        'https://login.dev.ctxhost.com/api/auth/oauth/google/callback?code=abc&state=test-state',
        'oauth-state=test-state; oauth-provider=google',
      ),
    );

    expect(res.headers.get('location')).toContain('/register?');
    expect(res.headers.get('location')).toContain('error=waitlist_required');
    expect(res.headers.get('location')).toContain('email=newperson%40example.com');
    expect(mockPrismaCreate).not.toHaveBeenCalled();
    expectOAuthContextCleared(res);
  });
});
