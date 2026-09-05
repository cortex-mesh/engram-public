"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

interface SetPasswordButtonProps {
  clientId?: string | null;
}

interface SetPasswordRequestInit {
  method: "POST";
  headers?: Record<string, string>;
  body?: string;
}

export function buildSetPasswordRequestInit({
  clientId,
}: SetPasswordButtonProps): SetPasswordRequestInit {
  const body: { clientId?: string } = {};
  if (clientId) body.clientId = clientId;

  if (Object.keys(body).length === 0) {
    return { method: "POST" };
  }

  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// For OAuth-only accounts: requests a verified-email link that lets the user
// add a password (ADR-017). The password can't be set from this session
// directly — it requires proof of email control via the emailed link.
export default function SetPasswordButton({ clientId = null }: SetPasswordButtonProps) {
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function handleRequest() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/set-password/request", buildSetPasswordRequestInit({ clientId }));
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Could not send the link. Please try again.");
        return;
      }
      setSent(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <p className="text-sm text-muted-foreground">
        Check your email — we sent a link to set your password.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <Button variant="outline" onClick={handleRequest} disabled={loading} className="w-full">
        {loading ? "Sending…" : "Set a password"}
      </Button>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
