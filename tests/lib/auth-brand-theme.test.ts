import { describe, expect, it } from "vitest";

import { brandThemeForClient } from "@/lib/auth-brand-theme";

describe("brandThemeForClient", () => {
  it("maps Tradepost's web client to the Tradepost theme", () => {
    expect(brandThemeForClient("tradepost-web")).toBe("tradepost");
  });

  it("maps Cite the Move's first-party client to its isolated theme", () => {
    expect(brandThemeForClient("axon-web")).toBe("citethemove");
  });

  it("keeps bare and unknown clients on the default Engram theme", () => {
    expect(brandThemeForClient(null)).toBe("engram");
    expect(brandThemeForClient("synapse-native")).toBe("engram");
    expect(brandThemeForClient("unknown-client")).toBe("engram");
  });
});
