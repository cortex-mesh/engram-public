import { describe, expect, it } from "vitest";

import {
  REDIRECT_TARGET_PARAM,
  decodeRedirectTarget,
  encodeRedirectTarget,
  readRedirectTarget,
} from "@/lib/redirect-target";

const AUTHORIZE_TARGET =
  "/authorize?response_type=code&client_id=tradepost-web&redirect_uri=https%3A%2F%2Fccgtradepost.com%2Fauth%2Fcallback&code_challenge=abc&code_challenge_method=S256&app=tradepost&state=xyz";

describe("opaque continuation target", () => {
  it("round-trips a target that contains a nested query", () => {
    expect(decodeRedirectTarget(encodeRedirectTarget(AUTHORIZE_TARGET))).toBe(AUTHORIZE_TARGET);
  });

  it("encodes to something with no & or % to be split or decoded", () => {
    const encoded = encodeRedirectTarget(AUTHORIZE_TARGET);
    expect(encoded).not.toContain("&");
    expect(encoded).not.toContain("%");
    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("?");
  });

  // This is the production failure, reproduced. The serverless runtime decodes
  // the percent-encoded "&" before the app parses the query, so a nested
  // redirect_uri is split and everything after its first parameter is lost.
  // The opaque target must survive that exact mangling.
  it("survives the runtime decoding %26 into a real &", () => {
    const encoded = encodeRedirectTarget(AUTHORIZE_TARGET);

    // What the app actually receives on Lambda: the value was decoded once too
    // often, so the nested params became top-level ones.
    const mangled = new URLSearchParams(
      `redirect_uri=${AUTHORIZE_TARGET}&${REDIRECT_TARGET_PARAM}=${encoded}`,
    );

    // The legacy nested param is destroyed exactly as it is in production...
    expect(mangled.get("redirect_uri")).toBe("/authorize?response_type=code");
    expect(mangled.get("redirect_uri")).not.toContain("client_id");

    // ...but the opaque target is intact, so the flow still knows where to go.
    expect(readRedirectTarget(mangled)).toBe(AUTHORIZE_TARGET);
    expect(readRedirectTarget(mangled)).toContain("client_id=tradepost-web");
  });

  it("falls back to redirect_uri when no opaque target is present", () => {
    const params = new URLSearchParams("redirect_uri=/account");
    expect(readRedirectTarget(params)).toBe("/account");
  });

  it("ignores a malformed opaque target rather than throwing", () => {
    const params = new URLSearchParams(`${REDIRECT_TARGET_PARAM}=!!!not-base64!!!&redirect_uri=/account`);
    expect(readRedirectTarget(params)).toBe("/account");
  });
});
