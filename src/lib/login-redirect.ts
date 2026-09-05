export type PostLoginRedirect =
  | { kind: "internal"; target: string }
  | { kind: "external"; target: string };

export function classifyPostLoginRedirect(
  redirectUri: string,
  currentOrigin?: string,
): PostLoginRedirect {
  if (!redirectUri.startsWith("http://") && !redirectUri.startsWith("https://")) {
    return { kind: "internal", target: redirectUri };
  }

  try {
    const targetUrl = new URL(redirectUri);
    if (currentOrigin && targetUrl.origin === currentOrigin) {
      return {
        kind: "internal",
        target: `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`,
      };
    }
    return { kind: "external", target: redirectUri };
  } catch {
    return { kind: "internal", target: redirectUri };
  }
}
