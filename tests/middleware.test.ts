import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";

import { middleware } from "@/middleware";

const ORIGINAL_ENV = { ...process.env };

function request(headers?: HeadersInit) {
  return new NextRequest("https://login.ctxhost.com/api/health", { headers });
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("middleware origin secret", () => {
  it("rejects prod requests with no origin secret", () => {
    process.env.ENGRAM_DEPLOY_ENV = "prod";
    process.env.ENGRAM_ORIGIN_SECRET = "shared-secret";

    const response = middleware(request());

    expect(response.status).toBe(403);
  });

  it("rejects prod requests with the wrong origin secret", () => {
    process.env.ENGRAM_DEPLOY_ENV = "prod";
    process.env.ENGRAM_ORIGIN_SECRET = "shared-secret";

    const response = middleware(request({ "x-engram-origin-secret": "wrong" }));

    expect(response.status).toBe(403);
  });

  it("allows prod requests with the correct origin secret", () => {
    process.env.ENGRAM_DEPLOY_ENV = "prod";
    process.env.ENGRAM_ORIGIN_SECRET = "shared-secret";

    const response = middleware(request({ "x-engram-origin-secret": "shared-secret" }));

    expect(response.status).toBe(200);
  });

  it("does not require an origin secret outside prod", () => {
    process.env.ENGRAM_DEPLOY_ENV = "dev";
    delete process.env.ENGRAM_ORIGIN_SECRET;

    const response = middleware(request());

    expect(response.status).toBe(200);
  });
});
