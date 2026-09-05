import { describe, expect, it } from "vitest";
import {
  isAiProviderKey,
  providerSecretId,
  validateApiKeyFormat,
  AI_PROVIDER_KEYS,
} from "@/lib/provider-credentials";

describe("isAiProviderKey", () => {
  it("accepts all known provider keys", () => {
    for (const key of AI_PROVIDER_KEYS) {
      expect(isAiProviderKey(key)).toBe(true);
    }
  });
  it("rejects unknown strings", () => {
    expect(isAiProviderKey("openai")).toBe(false);
    expect(isAiProviderKey("")).toBe(false);
    expect(isAiProviderKey(null)).toBe(false);
    expect(isAiProviderKey(42)).toBe(false);
  });
});

describe("providerSecretId", () => {
  it("returns the ADR-021 D2 path", () => {
    process.env.ENGRAM_DEPLOY_ENV = "aws-dev";
    expect(providerSecretId("org-123", "anthropic_api")).toBe(
      "cortex/aws-dev/org/org-123/provider/anthropic_api",
    );
    delete process.env.ENGRAM_DEPLOY_ENV;
  });

  it("falls back to dev when ENGRAM_DEPLOY_ENV is not set", () => {
    delete process.env.ENGRAM_DEPLOY_ENV;
    expect(providerSecretId("org-abc", "codex")).toBe("cortex/dev/org/org-abc/provider/codex");
  });
});

describe("validateApiKeyFormat", () => {
  it("accepts a valid key", () => {
    expect(validateApiKeyFormat("sk-ant-api03-aaabbcccdddeeefff")).toBeNull();
    expect(validateApiKeyFormat("a".repeat(16))).toBeNull();
    expect(validateApiKeyFormat("a".repeat(512))).toBeNull();
  });

  it("rejects too-short keys", () => {
    expect(validateApiKeyFormat("")).not.toBeNull();
    expect(validateApiKeyFormat("short")).not.toBeNull();
  });

  it("rejects too-long keys", () => {
    expect(validateApiKeyFormat("a".repeat(513))).not.toBeNull();
  });

  it("rejects keys with whitespace", () => {
    expect(validateApiKeyFormat("sk-ant abc def ghi jkl")).not.toBeNull();
    expect(validateApiKeyFormat("sk-ant\tabc-def-ghi-jkl-mno")).not.toBeNull();
  });
});
