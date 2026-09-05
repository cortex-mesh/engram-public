import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.hoisted(() => {
  process.env.ENGRAM_URL = 'https://engram.rapidagent.dev:8443';
  process.env.ENGRAM_JWT_SECRET = 'test-secret-long-enough-for-hs256-signing';
  process.env.ENGRAM_GITHUB_CLIENT_ID = 'github-client';
  process.env.ENGRAM_GITHUB_CLIENT_SECRET = 'github-secret';
  process.env.NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING = 'https://plexus.dev.ctxhost.com';
  process.env.NEXT_PUBLIC_DASHBOARD_URL = 'https://plexus.dev.ctxhost.com';
});

const { mockExchangeGitHubCode, mockGetGitHubUser, mockFindOrCreateOAuthUser, mockPrismaCreate, mockPrismaUserFindUnique, mockPrismaNativeFindUnique } = vi.hoisted(() => ({
  mockExchangeGitHubCode: vi.fn(),
  mockGetGitHubUser: vi.fn(),
  mockFindOrCreateOAuthUser: vi.fn(),
  mockPrismaCreate: vi.fn(),
  mockPrismaUserFindUnique: vi.fn(),
  mockPrismaNativeFindUnique: vi.fn(),
}));

vi.mock('@/lib/oauth/github', () => ({
  getGitHubAuthUrl: vi.fn((redirectUri: string, state: string) => `https://github.com/login/oauth/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`),
  exchangeGitHubCode: mockExchangeGitHubCode,
  getGitHubUser: mockGetGitHubUser,
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

import { GET as StartGitHubOAuth } from '@/app/api/auth/oauth/github/route';
import { GET as GitHubOAuthCallback } from '@/app/api/auth/oauth/github/callback/route';
import { isAllowedRedirect } from '@/lib/auth-redirect';
import { PLATFORM_APPS, getAppUrl } from '@/lib/apps';

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

function mockSuccessfulGitHubSignIn() {
  mockExchangeGitHubCode.mockResolvedValue({ accessToken: 'github-token' });
  mockGetGitHubUser.mockResolvedValue({
    id: 'github-user-1', email: 'roland@example.com', name: 'Roland', login: 'roland', avatar_url: 'https://example.com/avatar.png',
  });
  mockFindOrCreateOAuthUser.mockResolvedValue({ user: { id: 'user-1', role: 'USER' }, isNewUser: false });
  mockPrismaUserFindUnique.mockResolvedValue({
    id: 'user-1', displayName: 'Roland', role: 'USER', lastOrgId: null, orgMembers: [],
  });
  mockPrismaCreate.mockResolvedValue({});
}

describe('GitHub OAuth redirect preservation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING', 'https://plexus.dev.ctxhost.com');
    vi.stubEnv('NEXT_PUBLIC_DASHBOARD_URL', 'https://plexus.dev.ctxhost.com');
  });

  it('stores redirect_uri when starting GitHub OAuth', async () => {
    expect(getAppUrl(PLATFORM_APPS[0])).toBe('https://plexus.dev.ctxhost.com');
    expect(isAllowedRedirect('https://plexus.dev.ctxhost.com/chat')).toBe(true);

    const res = await StartGitHubOAuth(
      makeRequest('https://engram.rapidagent.dev:8443/api/auth/oauth/github?redirect_uri=https%3A%2F%2Fplexus.dev.ctxhost.com%2Fchat'),
    );

    const cookies = res.headers.getSetCookie();
    const redirectCookie = cookies.find((c) => c.includes('oauth-redirect-uri='));
    expect(redirectCookie).toBeDefined();
    expect(decodeURIComponent(redirectCookie!)).toContain('https://plexus.dev.ctxhost.com/chat');
    expect(cookies.some((cookie) => cookie.includes('oauth-provider=github'))).toBe(true);
    expect(cookies).toContainEqual(expect.stringMatching(/^oauth-state=(?!;).+; Path=\/; Expires=.*; Max-Age=600; HttpOnly; SameSite=lax$/));
  });

  it('stores live state and client cookies for a direct Cite GitHub start', async () => {
    process.env.ENGRAM_URL = 'https://login.ctxhost.com';
    process.env.ENGRAM_ALLOWED_HOSTS = 'login.ctxhost.com,auth.citethemove.com';
    mockPrismaNativeFindUnique.mockResolvedValue({
      clientId: 'axon-web', enabled: true, authProviders: ['github'], signupMode: 'waitlist',
      redirectUris: [{ id: 'redirect-1' }],
    });

    const res = await StartGitHubOAuth(makeRequest(
      'https://auth.citethemove.com/api/auth/oauth/github?redirect_uri=https%3A%2F%2Fapp.citethemove.com%2Fauth%2Fcallback',
      undefined,
      { host: 'auth.citethemove.com' },
    ));

    const cookies = res.headers.getSetCookie();
    expect(cookies).toContainEqual(expect.stringMatching(/^oauth-state=(?!;).+; Path=\/; Expires=.*; Max-Age=600; HttpOnly; SameSite=lax$/));
    expect(cookies).toContainEqual(expect.stringMatching(/^oauth-client-id=axon-web; Path=\/; Expires=.*; Max-Age=600; HttpOnly; SameSite=lax$/));
    expect(cookies).toContainEqual(expect.stringContaining('oauth-redirect-uri=https%3A%2F%2Fapp.citethemove.com%2Fauth%2Fcallback'));
  });

  it('does not store a globally allowed Tradepost continuation for a Cite GitHub start', async () => {
    process.env.ENGRAM_URL = 'https://login.ctxhost.com';
    process.env.ENGRAM_ALLOWED_HOSTS = 'login.ctxhost.com,auth.citethemove.com';
    process.env.NEXT_PUBLIC_ENGRAM_DEFAULT_LANDING = 'https://ccgtradepost.com';
    mockPrismaNativeFindUnique.mockResolvedValue({
      clientId: 'axon-web', enabled: true, authProviders: ['github'], signupMode: 'waitlist', redirectUris: [],
    });

    const res = await StartGitHubOAuth(makeRequest(
      'https://auth.citethemove.com/api/auth/oauth/github?redirect_uri=https%3A%2F%2Fccgtradepost.com%2Faccount',
      undefined,
      { host: 'auth.citethemove.com' },
    ));

    expect(res.headers.getSetCookie()).toContainEqual(
      expect.stringContaining('oauth-redirect-uri=; Path=/; Max-Age=0'),
    );
  });

  it('clears stale redirect and client context when a sequential GitHub flow omits both', async () => {
    mockPrismaNativeFindUnique.mockResolvedValue({
      clientId: 'axon-web', displayName: 'Cite the Move', brandName: 'Cite the Move',
      brandTagline: null, brandLogoUrl: null, brandPrimaryColor: null,
      authProviders: ['github'], signupMode: 'waitlist', enabled: true,
    });
    await StartGitHubOAuth(makeRequest(
      'https://engram.rapidagent.dev:8443/api/auth/oauth/github?client_id=axon-web&redirect_uri=https%3A%2F%2Fplexus.dev.ctxhost.com%2Fchat',
    ));

    const res = await StartGitHubOAuth(makeRequest(
      'https://engram.rapidagent.dev:8443/api/auth/oauth/github',
      'oauth-state=old; oauth-provider=github; oauth-client-id=axon-web; oauth-redirect-uri=' + encodeURIComponent('https://plexus.dev.ctxhost.com/chat'),
    ));
    const cookies = res.headers.getSetCookie();

    expect(cookies).toContainEqual(expect.stringContaining('oauth-redirect-uri=; Path=/; Max-Age=0'));
    expect(cookies).toContainEqual(expect.stringContaining('oauth-client-id=; Path=/; Max-Age=0'));
    expect(cookies).toContainEqual(expect.stringContaining('oauth-provider=github'));
  });

  it('clears every OAuth context cookie on a terminal GitHub state error', async () => {
    const res = await GitHubOAuthCallback(makeRequest(
      'https://engram.rapidagent.dev:8443/api/auth/oauth/github/callback?code=abc&state=wrong-state',
      'oauth-state=test-state; oauth-provider=github; oauth-client-id=axon-web; oauth-redirect-uri=https%3A%2F%2Fplexus.dev.ctxhost.com%2Fchat',
    ));

    expectOAuthContextCleared(res);
  });

  it('clears every OAuth context cookie when GitHub OAuth is unconfigured', async () => {
    const clientId = process.env.ENGRAM_GITHUB_CLIENT_ID;
    delete process.env.ENGRAM_GITHUB_CLIENT_ID;
    try {
      const res = await StartGitHubOAuth(makeRequest(
        'https://engram.rapidagent.dev:8443/api/auth/oauth/github',
        'oauth-state=old; oauth-provider=google; oauth-client-id=axon-web; oauth-redirect-uri=https%3A%2F%2Fplexus.dev.ctxhost.com%2Fchat',
      ));

      expect(res.status).toBe(501);
      expectOAuthContextCleared(res);
    } finally {
      if (clientId === undefined) delete process.env.ENGRAM_GITHUB_CLIENT_ID;
      else process.env.ENGRAM_GITHUB_CLIENT_ID = clientId;
    }
  });

  it('clears every OAuth context cookie when Cite rejects a GitHub client', async () => {
    vi.stubEnv('ENGRAM_ALLOWED_HOSTS', 'auth.citethemove.com');

    const res = await StartGitHubOAuth(makeRequest(
      'https://auth.citethemove.com/api/auth/oauth/github?client_id=tradepost-web',
      'oauth-state=old; oauth-provider=google; oauth-client-id=axon-web; oauth-redirect-uri=https%3A%2F%2Fplexus.dev.ctxhost.com%2Fchat',
      { host: 'auth.citethemove.com' },
    ));

    expect(res.status).toBe(400);
    expectOAuthContextCleared(res);
  });

  it('clears every OAuth context cookie when GitHub is disabled for a client', async () => {
    mockPrismaNativeFindUnique.mockResolvedValue({
      clientId: 'axon-web', displayName: 'Cite the Move', brandName: 'Cite the Move',
      brandTagline: null, brandLogoUrl: null, brandPrimaryColor: null,
      authProviders: ['google'], signupMode: 'waitlist', enabled: true,
    });

    const res = await StartGitHubOAuth(makeRequest(
      'https://engram.rapidagent.dev:8443/api/auth/oauth/github?client_id=axon-web',
      'oauth-state=old; oauth-provider=google; oauth-client-id=axon-web; oauth-redirect-uri=https%3A%2F%2Fplexus.dev.ctxhost.com%2Fchat',
    ));

    expect(res.status).toBe(403);
    expectOAuthContextCleared(res);
  });

  it.each([
    ['missing', null],
    ['disabled', { clientId: 'axon-web', enabled: false, authProviders: ['github'] }],
    ['empty provider list', { clientId: 'axon-web', enabled: true, authProviders: [] }],
    ['invalid provider list', { clientId: 'axon-web', enabled: true, authProviders: ['saml'] }],
  ])('fails closed and clears every context cookie when GitHub OAuth start has a %s axon-web configuration', async (_label, client) => {
    mockPrismaNativeFindUnique.mockResolvedValue(client);

    const res = await StartGitHubOAuth(makeRequest(
      'https://engram.rapidagent.dev:8443/api/auth/oauth/github?client_id=axon-web',
      'oauth-state=old; oauth-provider=google; oauth-client-id=axon-web; oauth-redirect-uri=https%3A%2F%2Fplexus.dev.ctxhost.com%2Fchat',
    ));

    expect(res.status).toBe(403);
    expect(res.headers.get('location')).toBeNull();
    expectOAuthContextCleared(res);
  });

  it('fails closed and clears every context cookie when GitHub OAuth start cannot load its client', async () => {
    vi.stubEnv('ENGRAM_ALLOWED_HOSTS', 'auth.citethemove.com');
    mockPrismaNativeFindUnique.mockRejectedValue(new Error('database unavailable'));

    const res = await StartGitHubOAuth(makeRequest(
      'https://auth.citethemove.com/api/auth/oauth/github',
      'oauth-state=old; oauth-provider=google; oauth-client-id=axon-web; oauth-redirect-uri=https%3A%2F%2Fplexus.dev.ctxhost.com%2Fchat',
      { host: 'auth.citethemove.com' },
    ));

    expect(res.status).toBe(503);
    expectOAuthContextCleared(res);
  });

  it('fails closed and clears every context cookie when GitHub callback policy lookup rejects', async () => {
    vi.stubEnv('ENGRAM_ALLOWED_HOSTS', 'auth.citethemove.com');
    mockPrismaNativeFindUnique.mockRejectedValue(new Error('database unavailable'));

    const res = await GitHubOAuthCallback(makeRequest(
      'https://auth.citethemove.com/api/auth/oauth/github/callback?code=abc&state=test-state',
      'oauth-state=test-state; oauth-provider=github; oauth-client-id=axon-web; oauth-redirect-uri=https%3A%2F%2Fplexus.dev.ctxhost.com%2Fchat',
      { host: 'auth.citethemove.com' },
    ));

    expect(res.headers.get('location')).toContain('error=oauth_invalid_client');
    expectOAuthContextCleared(res);
    expect(mockExchangeGitHubCode).not.toHaveBeenCalled();
  });

  it('rejects replay of Google-bound state at the GitHub callback before exchange', async () => {
    const res = await GitHubOAuthCallback(makeRequest(
      'https://engram.rapidagent.dev:8443/api/auth/oauth/github/callback?code=abc&state=test-state',
      'oauth-state=test-state; oauth-provider=google',
    ));

    expect(res.headers.get('location')).toContain('error=oauth_invalid_state');
    expect(mockExchangeGitHubCode).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['disabled', { clientId: 'axon-web', enabled: false, authProviders: ['github'] }],
    ['empty policy', { clientId: 'axon-web', enabled: true, authProviders: [] }],
    ['all-invalid policy', { clientId: 'axon-web', enabled: true, authProviders: ['saml'] }],
  ])('rejects a %s native client policy before GitHub provider exchange or account effects', async (_label, client) => {
    mockPrismaNativeFindUnique.mockResolvedValue(client);

    const res = await GitHubOAuthCallback(makeRequest(
      'https://engram.rapidagent.dev:8443/api/auth/oauth/github/callback?code=abc&state=test-state',
      'oauth-state=test-state; oauth-provider=github; oauth-client-id=axon-web',
    ));

    expect(res.headers.get('location')).toContain('error=oauth_invalid_client');
    expect(mockExchangeGitHubCode).not.toHaveBeenCalled();
    expect(mockFindOrCreateOAuthUser).not.toHaveBeenCalled();
    expect(mockPrismaCreate).not.toHaveBeenCalled();
  });

  it('redirects unknown GitHub OAuth users to the waitlist page instead of creating an account', async () => {
    mockExchangeGitHubCode.mockResolvedValue({ accessToken: 'github-token' });
    mockGetGitHubUser.mockResolvedValue({
      id: 'github-user-2',
      email: 'newperson@example.com',
      name: 'New Person',
      login: 'newperson',
      avatar_url: 'https://example.com/avatar.png',
    });
    mockFindOrCreateOAuthUser.mockResolvedValue(null);

    const res = await GitHubOAuthCallback(
      makeRequest(
        'https://engram.rapidagent.dev:8443/api/auth/oauth/github/callback?code=abc&state=test-state',
        'oauth-state=test-state; oauth-provider=github',
      ),
    );

    expect(res.headers.get('location')).toContain('/register?');
    expect(res.headers.get('location')).toContain('error=waitlist_required');
    expect(res.headers.get('location')).toContain('email=newperson%40example.com');
    expect(mockPrismaCreate).not.toHaveBeenCalled();
    expectOAuthContextCleared(res);
  });

  it('clears every OAuth context cookie after a successful GitHub OAuth callback', async () => {
    mockExchangeGitHubCode.mockResolvedValue({ accessToken: 'github-token' });
    mockGetGitHubUser.mockResolvedValue({
      id: 'github-user-1', email: 'roland@rapidagent.dev', name: 'Roland', login: 'roland', avatar_url: 'https://example.com/avatar.png',
    });
    mockFindOrCreateOAuthUser.mockResolvedValue({ user: { id: 'user-1', role: 'USER' }, isNewUser: false });
    mockPrismaUserFindUnique.mockResolvedValue({
      id: 'user-1', displayName: 'Roland', role: 'USER', lastOrgId: null,
      orgMembers: [{ org: { id: 'org-1', slug: 'cortex' } }],
    });
    mockPrismaCreate.mockResolvedValue({});

    const res = await GitHubOAuthCallback(makeRequest(
      'https://engram.rapidagent.dev:8443/api/auth/oauth/github/callback?code=abc&state=test-state',
      'oauth-state=test-state; oauth-provider=github; oauth-redirect-uri=' + encodeURIComponent('https://plexus.dev.ctxhost.com/chat'),
    ));

    expect(res.headers.get('location')).toBe('https://plexus.dev.ctxhost.com/chat');
    expectOAuthContextCleared(res);
  });

  it('honors the enabled Cite production callback after GitHub OAuth', async () => {
    process.env.ENGRAM_URL = 'https://login.ctxhost.com';
    process.env.ENGRAM_ALLOWED_HOSTS = 'login.ctxhost.com,auth.citethemove.com';
    mockPrismaNativeFindUnique.mockResolvedValue({
      clientId: 'axon-web', enabled: true, authProviders: ['github'], signupMode: 'waitlist',
      redirectUris: [{ id: 'redirect-1' }],
    });
    mockSuccessfulGitHubSignIn();

    const res = await GitHubOAuthCallback(makeRequest(
      'https://auth.citethemove.com/api/auth/oauth/github/callback?code=abc&state=test-state',
      'oauth-state=test-state; oauth-provider=github; oauth-client-id=axon-web; oauth-redirect-uri=' + encodeURIComponent('https://app.citethemove.com/auth/callback'),
      { host: 'auth.citethemove.com' },
    ));

    expect(res.headers.get('location')).toBe('https://app.citethemove.com/auth/callback');
  });

  it('falls back to Cite account when its production callback registration is disabled or missing', async () => {
    process.env.ENGRAM_URL = 'https://login.ctxhost.com';
    process.env.ENGRAM_ALLOWED_HOSTS = 'login.ctxhost.com,auth.citethemove.com';
    mockPrismaNativeFindUnique
      .mockResolvedValueOnce({
        clientId: 'axon-web', enabled: true, authProviders: ['github'], signupMode: 'waitlist',
      })
      .mockResolvedValueOnce({ enabled: true, redirectUris: [] });
    mockSuccessfulGitHubSignIn();

    const res = await GitHubOAuthCallback(makeRequest(
      'https://auth.citethemove.com/api/auth/oauth/github/callback?code=abc&state=test-state',
      'oauth-state=test-state; oauth-provider=github; oauth-client-id=axon-web; oauth-redirect-uri=' + encodeURIComponent('https://app.citethemove.com/auth/callback'),
      { host: 'auth.citethemove.com' },
    ));

    expect(res.headers.get('location')).toBe('https://auth.citethemove.com/account?client_id=axon-web');
  });

  it('falls back to Cite account for a GitHub callback registered to the wrong environment', async () => {
    process.env.ENGRAM_URL = 'https://login.ctxhost.com';
    process.env.ENGRAM_ALLOWED_HOSTS = 'login.ctxhost.com,auth.citethemove.com';
    mockPrismaNativeFindUnique.mockResolvedValue({
      clientId: 'axon-web', enabled: true, authProviders: ['github'], signupMode: 'waitlist',
    });
    mockSuccessfulGitHubSignIn();

    const res = await GitHubOAuthCallback(makeRequest(
      'https://auth.citethemove.com/api/auth/oauth/github/callback?code=abc&state=test-state',
      'oauth-state=test-state; oauth-provider=github; oauth-client-id=axon-web; oauth-redirect-uri=' + encodeURIComponent('https://axon.dev.ctxhost.com/auth/callback'),
      { host: 'auth.citethemove.com' },
    ));

    expect(res.headers.get('location')).toBe('https://auth.citethemove.com/account?client_id=axon-web');
  });

  it('uses the same-host Cite account fallback when GitHub has no continuation', async () => {
    process.env.ENGRAM_URL = 'https://login.ctxhost.com';
    process.env.ENGRAM_ALLOWED_HOSTS = 'login.ctxhost.com,auth.citethemove.com';
    mockPrismaNativeFindUnique.mockResolvedValue({
      clientId: 'axon-web', enabled: true, authProviders: ['github'], signupMode: 'waitlist',
    });
    mockSuccessfulGitHubSignIn();

    const res = await GitHubOAuthCallback(makeRequest(
      'https://auth.citethemove.com/api/auth/oauth/github/callback?code=abc&state=test-state',
      'oauth-state=test-state; oauth-provider=github; oauth-client-id=axon-web',
      { host: 'auth.citethemove.com' },
    ));

    expect(res.headers.get('location')).toBe('https://auth.citethemove.com/account?client_id=axon-web');
  });

  it('rejects recursively nested conflicting client ids on the Cite callback before exchanging the GitHub code', async () => {
    vi.stubEnv('ENGRAM_URL', 'https://login.ctxhost.com');
    vi.stubEnv('ENGRAM_ALLOWED_HOSTS', 'login.ctxhost.com,auth.citethemove.com');

    const nested = '/continue?client_id=tradepost-web!';
    const res = await GitHubOAuthCallback(makeRequest(
      'https://auth.citethemove.com/api/auth/oauth/github/callback?code=abc&state=test-state',
      'oauth-state=test-state; oauth-provider=github; oauth-client-id=axon-web; oauth-redirect-uri=' + encodeURIComponent(
        '/authorize?client_id=axon-web&redirect_uri=' + encodeURIComponent(nested),
      ),
      { host: 'auth.citethemove.com' },
    ));

    expect(res.headers.get('location')).toContain('error=oauth_invalid_client');
    expect(mockExchangeGitHubCode).not.toHaveBeenCalled();
    expect(mockFindOrCreateOAuthUser).not.toHaveBeenCalled();
  });
});
