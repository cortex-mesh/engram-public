const GITHUB_CLIENT_ID = process.env.ENGRAM_GITHUB_CLIENT_ID || "";
const GITHUB_CLIENT_SECRET = process.env.ENGRAM_GITHUB_CLIENT_SECRET || "";
const GITHUB_SCOPE = "user:email";

export function getGitHubAuthUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: GITHUB_SCOPE,
    state,
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

export async function exchangeGitHubCode(code: string, redirectUri: string): Promise<{ accessToken: string }> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error_description || data.error);
  return { accessToken: data.access_token };
}

export async function getGitHubUser(accessToken: string): Promise<{
  id: number;
  login: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  avatar_url: string;
}> {
  const res = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error("Failed to fetch GitHub user");
  const user = await res.json();

  // The /user `email` is the user's *public profile* email and carries no
  // contractual verification guarantee, so never trust it for account
  // linking. Always resolve the address from /user/emails and use only the
  // primary VERIFIED one (audit 2026-06-10, #6). If none is verified, the
  // email is null + emailVerified false → linking is refused downstream.
  let email: string | null = null;
  let emailVerified = false;

  const emailRes = await fetch("https://api.github.com/user/emails", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (emailRes.ok) {
    const emails = (await emailRes.json()) as Array<{
      primary: boolean;
      verified: boolean;
      email: string;
    }>;
    const primaryVerified = emails.find((e) => e.primary && e.verified);
    if (primaryVerified) {
      email = primaryVerified.email;
      emailVerified = true;
    }
  }

  return {
    id: user.id,
    login: user.login,
    email,
    emailVerified,
    name: user.name,
    avatar_url: user.avatar_url,
  };
}
