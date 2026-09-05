import { afterEach, describe, expect, it, vi } from "vitest";

import { getGoogleUser } from "@/lib/oauth/google";

function mockUserinfo(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => body }) as Response),
  );
}

describe("getGoogleUser", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps verified_email=true to emailVerified true", async () => {
    mockUserinfo({
      id: "g1",
      email: "user@example.com",
      verified_email: true,
      name: "User",
      picture: "p",
    });

    const user = await getGoogleUser("tok");
    expect(user.email).toBe("user@example.com");
    expect(user.emailVerified).toBe(true);
  });

  it("treats a missing or false verified_email as unverified", async () => {
    mockUserinfo({ id: "g2", email: "user@example.com", name: "User", picture: "p" });
    expect((await getGoogleUser("tok")).emailVerified).toBe(false);

    mockUserinfo({
      id: "g3",
      email: "user@example.com",
      verified_email: false,
      name: "User",
      picture: "p",
    });
    expect((await getGoogleUser("tok")).emailVerified).toBe(false);
  });
});
