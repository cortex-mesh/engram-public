// Per-org AI provider credential helpers (ADR-021).

import { type AiProviderKey } from "@/generated/prisma/client";

export const AI_PROVIDER_KEYS: readonly AiProviderKey[] = [
  "anthropic_api",
  "codex",
  "kimi",
  "openclaw",
  "hermes",
];

export function isAiProviderKey(value: unknown): value is AiProviderKey {
  return typeof value === "string" && (AI_PROVIDER_KEYS as readonly string[]).includes(value);
}

// ADR-021 D2: cortex/<env>/org/<orgId>/provider/<provider>
export function providerSecretId(orgId: string, provider: string): string {
  const env = process.env.ENGRAM_DEPLOY_ENV ?? "dev";
  return `cortex/${env}/org/${orgId}/provider/${provider}`;
}

// Key format validation: non-empty, printable ASCII, reasonable length.
// Provider-specific prefix checks would couple us to vendor key formats that
// can change; a length+charset guard is sufficient for the store layer.
export function validateApiKeyFormat(key: string): string | null {
  if (!key || key.length < 16) return "API key is too short (minimum 16 characters).";
  if (key.length > 512) return "API key is too long (maximum 512 characters).";
  if (/\s/.test(key)) return "API key must not contain whitespace.";
  return null;
}

// Live provider test: make a cheap API call to verify the key is accepted.
// External providers (anthropic_api, codex) get a real HTTP ping.
// Internal providers (openclaw, hermes, kimi) return a format-only result.
export async function testProviderKey(
  provider: AiProviderKey,
  apiKey: string,
): Promise<{ ok: boolean; detail: string }> {
  const formatError = validateApiKeyFormat(apiKey);
  if (formatError) return { ok: false, detail: formatError };

  if (provider === "anthropic_api") {
    return pingAnthropicKey(apiKey);
  }
  if (provider === "codex") {
    return pingOpenAiKey(apiKey);
  }
  // kimi, openclaw, hermes: format validated; live test not available here.
  return { ok: true, detail: "Format validated. Live ping not available for this provider." };
}

async function pingAnthropicKey(apiKey: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    });
    if (res.ok) return { ok: true, detail: "Key accepted by Anthropic API." };
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    const msg = body?.error?.message ?? `HTTP ${res.status}`;
    return { ok: false, detail: `Anthropic API rejected key: ${msg}` };
  } catch {
    return { ok: false, detail: "Unable to reach Anthropic API." };
  }
}

async function pingOpenAiKey(apiKey: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) return { ok: true, detail: "Key accepted by OpenAI API." };
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    const msg = body?.error?.message ?? `HTTP ${res.status}`;
    return { ok: false, detail: `OpenAI API rejected key: ${msg}` };
  } catch {
    return { ok: false, detail: "Unable to reach OpenAI API." };
  }
}
