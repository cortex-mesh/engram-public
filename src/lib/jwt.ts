import {
  SignJWT,
  exportJWK,
  importPKCS8,
  importSPKI,
  jwtVerify,
  type JWK,
  type JWTPayload,
} from "jose";
import { randomUUID } from "crypto";

type JwtAlgorithm = "HS256" | "RS256";

function getJwtSecret(): Uint8Array {
  const secret = process.env.ENGRAM_JWT_SECRET;
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error("ENGRAM_JWT_SECRET must be set in production");
  }
  return new TextEncoder().encode(
    secret || "dev-secret-change-in-production",
  );
}

function getJwtAlgorithm(): JwtAlgorithm {
  const configured = process.env.ENGRAM_JWT_ALGORITHM?.trim().toUpperCase();
  if (!configured) return "HS256";
  if (configured === "HS256" || configured === "RS256") return configured;
  throw new Error("ENGRAM_JWT_ALGORITHM must be HS256 or RS256");
}

function normalizedPem(value: string | undefined, name: string): string {
  const pem = value?.trim().replace(/\\n/g, "\n");
  if (!pem) throw new Error(`${name} must be set when ENGRAM_JWT_ALGORITHM=RS256`);
  return pem;
}

function getJwtKeyId(): string {
  const keyId = process.env.ENGRAM_JWT_KEY_ID?.trim();
  if (!keyId) throw new Error("ENGRAM_JWT_KEY_ID must be set when ENGRAM_JWT_ALGORITHM=RS256");
  return keyId;
}

let rs256PrivateKey: Promise<CryptoKey> | undefined;
let rs256PublicKey: Promise<CryptoKey> | undefined;

function getRs256PrivateKey(): Promise<CryptoKey> {
  rs256PrivateKey ??= importPKCS8(
    normalizedPem(process.env.ENGRAM_JWT_PRIVATE_KEY, "ENGRAM_JWT_PRIVATE_KEY"),
    "RS256",
  );
  return rs256PrivateKey;
}

function getRs256PublicKey(): Promise<CryptoKey> {
  rs256PublicKey ??= importSPKI(
    normalizedPem(process.env.ENGRAM_JWT_PUBLIC_KEY, "ENGRAM_JWT_PUBLIC_KEY"),
    "RS256",
  );
  return rs256PublicKey;
}

const ISSUER = "engram";
const ACCESS_TOKEN_TTL = "15m";
const REFRESH_TOKEN_TTL = "30d";

export interface TokenPayload {
  userId: string;
  displayName?: string;
  role?: string;
  type: "access" | "refresh";
}

export async function signAccessToken(payload: {
  userId: string;
  displayName?: string | null;
  role?: string;
}): Promise<string> {
  const algorithm = getJwtAlgorithm();
  return new SignJWT({ ...payload, type: "access" } as unknown as JWTPayload)
    .setProtectedHeader(
      algorithm === "RS256" ? { alg: "RS256", kid: getJwtKeyId() } : { alg: "HS256" },
    )
    .setIssuer(ISSUER)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_TTL)
    .sign(algorithm === "RS256" ? await getRs256PrivateKey() : getJwtSecret());
}

export async function signRefreshToken(userId: string): Promise<string> {
  const algorithm = getJwtAlgorithm();
  return new SignJWT({ userId, type: "refresh" } as unknown as JWTPayload)
    .setProtectedHeader(
      algorithm === "RS256" ? { alg: "RS256", kid: getJwtKeyId() } : { alg: "HS256" },
    )
    .setIssuer(ISSUER)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(REFRESH_TOKEN_TTL)
    .sign(algorithm === "RS256" ? await getRs256PrivateKey() : getJwtSecret());
}

export async function verifyToken(token: string): Promise<TokenPayload> {
  const algorithm = getJwtAlgorithm();
  const { payload } = await jwtVerify(
    token,
    algorithm === "RS256" ? await getRs256PublicKey() : getJwtSecret(),
    {
    issuer: ISSUER,
      algorithms: [algorithm],
    },
  );
  return payload as unknown as TokenPayload;
}

export async function getPublicJwks(): Promise<{ keys: JWK[] }> {
  if (getJwtAlgorithm() !== "RS256") {
    return { keys: [] };
  }
  const jwk = await exportJWK(await getRs256PublicKey());
  return {
    keys: [
      {
        ...jwk,
        kid: getJwtKeyId(),
        alg: "RS256",
        use: "sig",
      },
    ],
  };
}

export async function generateTokenPair(user: {
  id: string;
  displayName?: string | null;
  role?: string;
}): Promise<{ accessToken: string; refreshToken: string }> {
  const [accessToken, refreshToken] = await Promise.all([
    signAccessToken({ userId: user.id, displayName: user.displayName, role: user.role }),
    signRefreshToken(user.id),
  ]);
  return { accessToken, refreshToken };
}

// Cookie configuration
export const ACCESS_COOKIE_NAME = "engram-access";
export const REFRESH_COOKIE_NAME = "engram-refresh";

// Shared domain for cross-subdomain SSO (e.g., ".rapidagent.dev")
// Set via ENGRAM_COOKIE_DOMAIN env var. When unset, cookies are scoped to
// the request host only (host-only cookie).
const COOKIE_DOMAIN = process.env.ENGRAM_COOKIE_DOMAIN;

export const ACCESS_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: 15 * 60, // 15 minutes
  ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
};

export const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/api/auth",
  maxAge: 30 * 24 * 60 * 60, // 30 days
  ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
};

function expiredCookie(name: string, path: string, domain?: string): string {
  const parts = [
    `${name}=`,
    `Path=${path}`,
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (process.env.NODE_ENV === "production") {
    parts.push("Secure");
  }
  if (domain) {
    parts.push(`Domain=${domain}`);
  }
  return parts.join("; ");
}

// Clears both the host-only and (when configured) the domain-scoped variant
// of each auth cookie. A browser can hold both — e.g. a session minted
// before ENGRAM_COOKIE_DOMAIN was introduced or changed — and a delete only
// matches a cookie with the same name+domain+path, so clearing just one
// variant leaves the other authenticating requests. Raw header appends
// because ResponseCookies.set() is keyed by name and would collapse the two
// variants into one Set-Cookie.
export function clearAuthCookies(response: { headers: Headers }): void {
  for (const [name, path] of [
    [ACCESS_COOKIE_NAME, ACCESS_COOKIE_OPTIONS.path],
    [REFRESH_COOKIE_NAME, REFRESH_COOKIE_OPTIONS.path],
  ] as const) {
    response.headers.append("Set-Cookie", expiredCookie(name, path));
    if (COOKIE_DOMAIN) {
      response.headers.append("Set-Cookie", expiredCookie(name, path, COOKIE_DOMAIN));
    }
  }
}
