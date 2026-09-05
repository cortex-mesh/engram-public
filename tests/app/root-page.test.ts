import { describe, expect, it, vi } from "vitest";

const { redirect } = vi.hoisted(() => ({ redirect: vi.fn() }));

vi.mock("next/navigation", () => ({ redirect }));

import Home from "@/app/page";

describe("bare auth root", () => {
  it("delegates every bare auth host to the continuation route", () => {
    Home();

    expect(redirect).toHaveBeenCalledWith("/api/auth/continue");
  });
});
