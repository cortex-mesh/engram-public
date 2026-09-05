// The continuation target used to be nested raw inside a query parameter
// (redirect_uri=/authorize?response_type=code&client_id=...). On the serverless
// runtime the percent-encoded "&" is decoded before the app parses the query,
// so the nested URL is split and everything after its first parameter is
// discarded. A long-running container preserves it, which is why this only
// ever broke production: the user came back to /authorize with client_id gone
// ("invalid_client"), and the login page had no client left to brand itself
// with.
//
// The target is opaque state, not a nested query. Carry it base64url-encoded
// so no layer can decode, split, or re-encode it. redirect_uri is still
// emitted and still read, so existing links keep working.
//
// Isomorphic on purpose: the login form runs in the browser (no Buffer) and
// the routes run on the server (no atob guarantee pre-Node 16).

export const REDIRECT_TARGET_PARAM = "rt";

function toBase64Url(base64: string): string {
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return padded + "=".repeat((4 - (padded.length % 4)) % 4);
}

export function encodeRedirectTarget(target: string): string {
  const bytes = new TextEncoder().encode(target);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return toBase64Url(btoa(binary));
}

export function decodeRedirectTarget(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const binary = atob(fromBase64Url(value));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    // atob accepts anything in the base64 alphabet and TextDecoder emits
    // replacement characters rather than throwing, so a corrupted value can
    // "decode" into junk. Junk must lose to the legacy redirect_uri, not
    // silently dump the user on the landing page.
    if (!decoded.startsWith("/") && !decoded.startsWith("http")) return null;
    if (decoded.includes("\uFFFD")) return null;
    return decoded;
  } catch {
    return null;
  }
}

// Prefer the opaque target; fall back to the legacy nested one.
export function readRedirectTarget(params: URLSearchParams): string | null {
  return (
    decodeRedirectTarget(params.get(REDIRECT_TARGET_PARAM)) ||
    params.get("redirect_uri")
  );
}
