"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

interface LogoutButtonProps {
  /**
   * Canonical login URL to navigate to after the logout request finishes.
   * Required so that signing out from the platform-admin surface
   * (e.g. https://platform.dev.ctxhost.com/account) still lands the user
   * on the canonical login host (https://login.dev.ctxhost.com/login)
   * instead of the host they happened to be on.
   */
  loginUrl: string;
}

export default function LogoutButton({ loginUrl }: LogoutButtonProps) {
  const [loading, setLoading] = useState(false);

  async function handleLogout() {
    setLoading(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      window.location.href = loginUrl;
    } catch {
      setLoading(false);
    }
  }

  return (
    <Button
      variant="outline"
      onClick={handleLogout}
      disabled={loading}
      className="w-full"
    >
      {loading ? "Signing out..." : "Sign out"}
    </Button>
  );
}
