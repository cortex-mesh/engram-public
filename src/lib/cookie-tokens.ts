import type { NextRequest } from "next/server";

function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getRawCookieValues(header: string | null, name: string): string[] {
  if (!header) return [];

  const values: string[] = [];
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const cookieName = trimmed.slice(0, eq).trim();
    if (cookieName !== name) continue;
    const value = decodeCookieValue(trimmed.slice(eq + 1).trim());
    if (value) values.push(value);
  }
  return values;
}

export function uniqueCookieValues(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export function getRequestCookieValues(request: NextRequest, name: string): string[] {
  return uniqueCookieValues([
    ...getRawCookieValues(request.headers.get("cookie"), name),
    request.cookies.get(name)?.value,
    ...request.cookies.getAll(name).map((cookie) => cookie.value),
  ]);
}
