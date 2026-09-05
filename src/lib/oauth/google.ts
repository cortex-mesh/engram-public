const GOOGLE_CLIENT_ID = process.env.ENGRAM_GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.ENGRAM_GOOGLE_CLIENT_SECRET || "";
const GOOGLE_SCOPE = "openid email profile";

export function getGoogleAuthUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPE,
    state,
    access_type: "offline",
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeGoogleCode(code: string, redirectUri: string): Promise<{ accessToken: string }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error_description || data.error);
  return { accessToken: data.access_token };
}

export async function getGoogleUser(accessToken: string): Promise<{
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  picture: string;
}> {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error("Failed to fetch Google user");
  const data = await res.json();
  // The v2 userinfo endpoint returns `verified_email`. Only treat the email
  // as trustworthy for account linking when Google has verified it (audit
  // 2026-06-10, #6) — an unverified provider email is an account-takeover
  // vector.
  return {
    id: data.id,
    email: data.email,
    emailVerified: data.verified_email === true,
    name: data.name,
    picture: data.picture,
  };
}
