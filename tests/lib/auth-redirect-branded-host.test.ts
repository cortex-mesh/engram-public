import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isAllowedRedirect } from "@/lib/auth-redirect";

const ENV = { ...process.env };

describe("branded auth host is a trusted redirect target", () => {
  beforeEach(() => {
    process.env.ENGRAM_URL = "https://login.ctxhost.com";
    process.env.ENGRAM_ALLOWED_HOSTS =
      "login.ctxhost.com,platform.ctxhost.com,auth.ccgtradepost.com";
  });

  afterEach(() => {
    process.env = { ...ENV };
  });

  // Regression: /authorize is served on the branded auth host, so the OAuth
  // return target lives there. It is neither ENGRAM_URL nor an app URL, so the
  // allowlist rejected it — the return was dropped and the user came back to
  // /authorize with its parameters stripped ("client_id is not registered").
  it("allows a return to the branded auth host Engram itself serves", () => {
    expect(
      isAllowedRedirect(
        "https://auth.ccgtradepost.com/authorize?response_type=code&client_id=tradepost-web",
      ),
    ).toBe(true);
  });

  it("still allows the canonical auth host", () => {
    expect(isAllowedRedirect("https://login.ctxhost.com/account")).toBe(true);
  });

  it("still refuses a host Engram does not serve", () => {
    expect(isAllowedRedirect("https://evil.example.com/authorize")).toBe(false);
  });

  it("refuses a host that merely looks like an allowed one", () => {
    expect(isAllowedRedirect("https://auth.ccgtradepost.com.evil.com/x")).toBe(false);
  });
});
