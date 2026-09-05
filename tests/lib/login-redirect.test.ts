import { describe, expect, it } from "vitest";
import { withAccountClientContext } from "@/lib/auth-redirect";
import { classifyPostLoginRedirect } from "@/lib/login-redirect";

describe("classifyPostLoginRedirect", () => {
  it("treats relative redirects as internal", () => {
    expect(classifyPostLoginRedirect("/account")).toEqual({
      kind: "internal",
      target: "/account",
    });
  });

  it("treats same-origin absolute redirects as internal", () => {
    expect(
      classifyPostLoginRedirect(
        "https://engram.rapidagent.dev:8443/account",
        "https://engram.rapidagent.dev:8443",
      ),
    ).toEqual({
      kind: "internal",
      target: "/account",
    });
  });

  it("treats cross-origin redirects as external", () => {
    expect(
      classifyPostLoginRedirect(
        "https://plexus.dev.ctxhost.com/chat",
        "https://engram.rapidagent.dev:8443",
      ),
    ).toEqual({
      kind: "external",
      target: "https://plexus.dev.ctxhost.com/chat",
    });
  });

  it("falls back to internal for invalid absolute targets", () => {
    expect(classifyPostLoginRedirect("not a valid url")).toEqual({
      kind: "internal",
      target: "not a valid url",
    });
  });
});

describe("withAccountClientContext", () => {
  it("adds client_id to the account fallback target", () => {
    expect(withAccountClientContext("/account", "tradepost-web")).toBe(
      "/account?client_id=tradepost-web",
    );
  });

  it("leaves non-account targets alone", () => {
    expect(withAccountClientContext("https://tradepost.dev.ctxhost.com/", "tradepost-web")).toBe(
      "https://tradepost.dev.ctxhost.com/",
    );
  });
});
