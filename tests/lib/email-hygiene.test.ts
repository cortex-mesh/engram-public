import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolve4, mockResolve6, mockResolveMx } = vi.hoisted(() => ({
  mockResolve4: vi.fn(),
  mockResolve6: vi.fn(),
  mockResolveMx: vi.fn(),
}));

vi.mock("node:dns", () => ({
  promises: {
    resolve4: mockResolve4,
    resolve6: mockResolve6,
    resolveMx: mockResolveMx,
  },
}));

import { validateSignupEmail } from "@/lib/email-hygiene";

describe("validateSignupEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveMx.mockResolvedValue([{ exchange: "mx.example.com", priority: 10 }]);
    mockResolve4.mockResolvedValue([]);
    mockResolve6.mockResolvedValue([]);
  });

  it("accepts domains with MX records", async () => {
    await expect(validateSignupEmail("person@example.com")).resolves.toEqual({
      status: "accepted",
      reason: null,
    });
    expect(mockResolveMx).toHaveBeenCalledWith("example.com");
  });

  it("rejects vendored disposable domains before DNS lookup", async () => {
    await expect(validateSignupEmail("junk@1secmail.com")).resolves.toEqual({
      status: "rejected_disposable",
      reason: "1secmail.com is a disposable email domain.",
    });
    await expect(validateSignupEmail("junk@web-library.net")).resolves.toEqual({
      status: "rejected_disposable",
      reason: "web-library.net is a disposable email domain.",
    });
    expect(mockResolveMx).not.toHaveBeenCalled();
  });

  it("accepts domains with no MX when an address record exists", async () => {
    mockResolveMx.mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOTFOUND" }));
    mockResolve4.mockResolvedValue(["192.0.2.10"]);

    await expect(validateSignupEmail("person@fallback.example")).resolves.toEqual({
      status: "accepted",
      reason: null,
    });
  });

  it("rejects domains with no MX and no address fallback", async () => {
    mockResolveMx.mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOTFOUND" }));
    mockResolve4.mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOTFOUND" }));
    mockResolve6.mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOTFOUND" }));

    await expect(validateSignupEmail("person@dead.example")).resolves.toEqual({
      status: "rejected_no_dns",
      reason: "dead.example has no MX record and no address fallback.",
    });
  });

  it("fails open and logs on transient DNS failures", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockResolveMx.mockRejectedValue(Object.assign(new Error("timeout"), { code: "ETIMEOUT" }));

    await expect(validateSignupEmail("person@example.com")).resolves.toEqual({
      status: "accepted",
      reason: null,
    });
    expect(consoleWarn).toHaveBeenCalledWith(
      "Email domain DNS check failed open:",
      expect.objectContaining({ domain: "example.com" }),
    );
    consoleWarn.mockRestore();
  });
});
