import { afterEach, describe, expect, it, vi } from "vitest";

import { getGitHubUser } from "@/lib/oauth/github";

function mockFetchSequence(
  userBody: unknown,
  emailsBody: unknown,
  opts: { emailsOk?: boolean } = {},
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "https://api.github.com/user") {
        return { ok: true, json: async () => userBody } as Response;
      }
      if (url === "https://api.github.com/user/emails") {
        return {
          ok: opts.emailsOk ?? true,
          json: async () => emailsBody,
        } as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
}

describe("getGitHubUser", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("ignores the /user profile email and uses the primary VERIFIED email", async () => {
    // The public profile email claims a victim's address...
    mockFetchSequence(
      { id: 1, login: "attacker", email: "victim@example.com", name: "A", avatar_url: "x" },
      [
        { email: "victim@example.com", primary: true, verified: false },
        { email: "attacker@example.com", primary: false, verified: true },
      ],
    );

    const user = await getGitHubUser("tok");
    // ...but no primary+verified address exists, so email is refused.
    expect(user.email).toBeNull();
    expect(user.emailVerified).toBe(false);
  });

  it("returns the verified primary email with emailVerified true", async () => {
    mockFetchSequence(
      { id: 2, login: "real", email: null, name: "R", avatar_url: "x" },
      [{ email: "real@example.com", primary: true, verified: true }],
    );

    const user = await getGitHubUser("tok");
    expect(user.email).toBe("real@example.com");
    expect(user.emailVerified).toBe(true);
  });

  it("refuses when the primary email is unverified", async () => {
    mockFetchSequence(
      { id: 3, login: "u", email: "u@example.com", name: "U", avatar_url: "x" },
      [{ email: "u@example.com", primary: true, verified: false }],
    );

    const user = await getGitHubUser("tok");
    expect(user.email).toBeNull();
    expect(user.emailVerified).toBe(false);
  });

  it("refuses when the emails endpoint is unavailable", async () => {
    mockFetchSequence(
      { id: 4, login: "u", email: "u@example.com", name: "U", avatar_url: "x" },
      [],
      { emailsOk: false },
    );

    const user = await getGitHubUser("tok");
    expect(user.email).toBeNull();
    expect(user.emailVerified).toBe(false);
  });
});
