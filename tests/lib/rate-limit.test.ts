import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetRateLimitForTests,
  _setRateLimitDynamoClientForTests,
  checkRateLimit,
  clearRateLimit,
  consumeRateLimit,
  getClientIp,
  rateLimitResponse,
  recordRateLimitHit,
} from "@/lib/rate-limit";
import { NextRequest } from "next/server";

describe("rate-limit", () => {
  beforeEach(() => {
    _resetRateLimitForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.ENGRAM_RATE_LIMIT_DISABLED;
    delete process.env.ENGRAM_RATE_LIMIT_DYNAMODB_TABLE;
  });

  it("allows up to the limit and blocks beyond it", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await consumeRateLimit("k", 5, 60_000)).allowed).toBe(true);
    }
    const blocked = await consumeRateLimit("k", 5, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("resets after the window expires", async () => {
    for (let i = 0; i < 6; i++) await consumeRateLimit("k", 5, 60_000);
    expect((await consumeRateLimit("k", 5, 60_000)).allowed).toBe(false);

    vi.advanceTimersByTime(61_000);
    expect((await consumeRateLimit("k", 5, 60_000)).allowed).toBe(true);
  });

  it("keys are independent", async () => {
    for (let i = 0; i < 6; i++) await consumeRateLimit("a", 5, 60_000);
    expect((await consumeRateLimit("a", 5, 60_000)).allowed).toBe(false);
    expect((await consumeRateLimit("b", 5, 60_000)).allowed).toBe(true);
  });

  it("checkRateLimit peeks without counting", async () => {
    expect((await checkRateLimit("k", 2)).allowed).toBe(true);
    expect((await checkRateLimit("k", 2)).allowed).toBe(true);

    await recordRateLimitHit("k", 60_000);
    expect((await checkRateLimit("k", 2)).allowed).toBe(true);
    await recordRateLimitHit("k", 60_000);
    expect((await checkRateLimit("k", 2)).allowed).toBe(false);

    vi.advanceTimersByTime(61_000);
    expect((await checkRateLimit("k", 2)).allowed).toBe(true);
  });

  it("clearRateLimit removes a key", async () => {
    await recordRateLimitHit("k", 60_000);
    await recordRateLimitHit("k", 60_000);
    expect((await checkRateLimit("k", 2)).allowed).toBe(false);

    await clearRateLimit("k");
    expect((await checkRateLimit("k", 2)).allowed).toBe(true);
  });

  it("is bypassed when ENGRAM_RATE_LIMIT_DISABLED=1", async () => {
    process.env.ENGRAM_RATE_LIMIT_DISABLED = "1";
    for (let i = 0; i < 20; i++) {
      expect((await consumeRateLimit("k", 5, 60_000)).allowed).toBe(true);
    }
    await recordRateLimitHit("k", 60_000);
    expect((await checkRateLimit("k", 0)).allowed).toBe(true);
  });

  it("does not call DynamoDB clear when rate limiting is disabled", async () => {
    process.env.ENGRAM_RATE_LIMIT_DISABLED = "1";
    process.env.ENGRAM_RATE_LIMIT_DYNAMODB_TABLE = "engram-spike-rate-limit";
    const send = vi.fn();
    _setRateLimitDynamoClientForTests({ send });

    await clearRateLimit("k");

    expect(send).not.toHaveBeenCalled();
  });

  it("uses DynamoDB when ENGRAM_RATE_LIMIT_DYNAMODB_TABLE is configured", async () => {
    process.env.ENGRAM_RATE_LIMIT_DYNAMODB_TABLE = "engram-spike-rate-limit";
    const calls: Array<{ name: string; input?: unknown }> = [];
    const client = {
      async send(command: unknown) {
        const record = command as { constructor?: { name?: string }; input?: unknown };
        calls.push({ name: record.constructor?.name || "UnknownCommand", input: record.input });
        if (record.constructor?.name === "UpdateItemCommand") {
          return {
            Attributes: { count: { N: "3" }, resetAt: { N: String(Date.now() + 60_000) } },
          };
        }
        return {};
      },
    };
    _setRateLimitDynamoClientForTests(client);

    const result = await consumeRateLimit("login:ip:198.51.100.9", 5, 60_000);

    expect(result.allowed).toBe(true);
    expect(calls.map((call) => call.name)).toEqual(["UpdateItemCommand"]);
    expect(calls[0]?.input).toMatchObject({
      TableName: "engram-spike-rate-limit",
      Key: { rateKey: { S: "login:ip:198.51.100.9" } },
      ConditionExpression: "#resetAt > :now",
      UpdateExpression: "ADD #count :one",
      ReturnValues: "ALL_NEW",
    });
  });

  it("rateLimitResponse returns 429 with Retry-After", async () => {
    const res = rateLimitResponse(42);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    await expect(res.json()).resolves.toEqual({ error: "Too many requests" });
  });

  describe("getClientIp", () => {
    function req(headers: Record<string, string>) {
      return new NextRequest(
        new Request("https://login.dev.ctxhost.com/api/auth/login", {
          method: "POST",
          headers,
        }),
      );
    }

    it("uses the LAST x-forwarded-for entry (appended by our proxy)", () => {
      expect(
        getClientIp(req({ "x-forwarded-for": "6.6.6.6, 198.51.100.7" })),
      ).toBe("198.51.100.7");
    });

    it("falls back to x-real-ip, then 'unknown'", () => {
      expect(getClientIp(req({ "x-real-ip": "203.0.113.9" }))).toBe(
        "203.0.113.9",
      );
      expect(getClientIp(req({}))).toBe("unknown");
    });
  });
});
