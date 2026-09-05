import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";

describe("Next response headers", () => {
  it("keeps no-store coverage on every API route, including enrollment snapshots", async () => {
    const rules = await nextConfig.headers?.();
    const apiRule = rules?.find((rule) => rule.source === "/api/:path*");
    expect(apiRule?.headers).toContainEqual({
      key: "Cache-Control",
      value: "no-store",
    });
    expect(
      rules?.some((rule) => rule.source.includes("enrollment/v1/snapshot")),
    ).toBe(false);
  });
});
