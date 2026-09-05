import { describe, expect, it } from "vitest";

import {
  CITE_THE_MOVE_CALLBACK,
  CITE_THE_MOVE_CLIENT_ID,
  needsCallbackEnable,
  redirectUrisToRemove,
} from "../../scripts/cite-production-client-contract.mjs";

describe("Cite the Move production client reconciliation", () => {
  it("pins the exact approved application callback", () => {
    expect(CITE_THE_MOVE_CALLBACK).toBe("https://app.citethemove.com/auth/callback");
  });

  it("converges redirect registrations to exactly the approved callback", () => {
    const registrations = [
      { redirectUri: "https://axon.dev.ctxhost.com/auth/callback", enabled: true },
      { redirectUri: CITE_THE_MOVE_CALLBACK, enabled: false },
      { redirectUri: "http://localhost:3103/auth/callback", enabled: true },
    ];

    expect(redirectUrisToRemove(registrations)).toEqual([
      "http://localhost:3103/auth/callback",
      "https://axon.dev.ctxhost.com/auth/callback",
    ]);
    expect(needsCallbackEnable(registrations)).toBe(true);
    expect(CITE_THE_MOVE_CLIENT_ID).toBe("axon-web");
  });

  it("is idempotent once the approved callback is the only enabled value", () => {
    const registrations = [{ redirectUri: CITE_THE_MOVE_CALLBACK, enabled: true }];
    expect(redirectUrisToRemove(registrations)).toEqual([]);
    expect(needsCallbackEnable(registrations)).toBe(false);
  });
});
