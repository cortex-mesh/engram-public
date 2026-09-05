import { describe, expect, it } from "vitest";
import { isLoopbackRequestHost, parseTenantTlsDomain } from "@/lib/tenant-tls";

describe("parseTenantTlsDomain", () => {
  it("maps dev tenant hostnames to organization slugs", () => {
    expect(parseTenantTlsDomain("demo.dev.ctxhost.com")).toEqual({
      slug: "demo",
      environment: "dev",
      hostname: "demo.dev.ctxhost.com",
    });
  });

  it("normalizes casing and a trailing DNS dot", () => {
    expect(parseTenantTlsDomain("Demo-Org.DEV.CTXHOST.COM.")).toEqual({
      slug: "demo-org",
      environment: "dev",
      hostname: "demo-org.dev.ctxhost.com",
    });
  });

  it("maps production tenant hostnames to organization slugs", () => {
    expect(parseTenantTlsDomain("demo.ctxhost.com")).toEqual({
      slug: "demo",
      environment: "prod",
      hostname: "demo.ctxhost.com",
    });
  });

  it("rejects reserved and malformed tenant hostnames", () => {
    expect(parseTenantTlsDomain("cortex.dev.ctxhost.com")).toBeNull();
    expect(parseTenantTlsDomain("login.dev.ctxhost.com")).toBeNull();
    expect(parseTenantTlsDomain("nested.demo.dev.ctxhost.com")).toBeNull();
    expect(parseTenantTlsDomain("bad_slug.dev.ctxhost.com")).toBeNull();
    expect(parseTenantTlsDomain("ctxhost.com")).toBeNull();
  });
});

describe("isLoopbackRequestHost", () => {
  it("accepts local Caddy ask requests", () => {
    expect(isLoopbackRequestHost("127.0.0.1:3104")).toBe(true);
    expect(isLoopbackRequestHost("localhost:3104")).toBe(true);
    expect(isLoopbackRequestHost("[::1]:3104")).toBe(true);
  });

  it("rejects public host headers", () => {
    expect(isLoopbackRequestHost("login.dev.ctxhost.com")).toBe(false);
    expect(isLoopbackRequestHost("demo.dev.ctxhost.com")).toBe(false);
  });
});
