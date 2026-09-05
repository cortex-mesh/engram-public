"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { AuthCardIntro } from "@/components/auth/auth-card-intro";

interface SetPasswordFormProps {
  brandName: string;
  clientId: string | null;
}

export function SetPasswordForm({ brandName, clientId }: SetPasswordFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") || "";
  const loginHref = clientId ? `/login?client_id=${encodeURIComponent(clientId)}` : "/login";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/set-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword: password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Could not set your password.");
        return;
      }
      setDone(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <Card>
        <AuthCardIntro
          eyebrow={brandName}
          title="Link expired"
          description="This set-password link is missing or invalid. Request a new one from sign-in."
        />
        <CardFooter className="pt-2">
          <Link href={loginHref}>Back to sign in</Link>
        </CardFooter>
      </Card>
    );
  }

  if (done) {
    return (
      <Card>
        <AuthCardIntro
          eyebrow={brandName}
          title="Password set"
          description="You can now sign in with your email and password."
        />
        <CardFooter className="pt-2">
          <Button className="w-full" onClick={() => router.push(loginHref)}>
            Continue to sign in
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card>
      <AuthCardIntro
        eyebrow={brandName}
        title="Set your password"
        description={`Choose a password for your ${brandName} account.`}
      />
      <form onSubmit={handleSubmit}>
        <CardContent className="space-y-5">
          {error ? (
            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="password">New password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              maxLength={72}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm">Confirm password</Label>
            <Input
              id="confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              minLength={8}
              maxLength={72}
              required
            />
          </div>
        </CardContent>
        <CardFooter className="pt-2">
          <Button type="submit" disabled={loading} className="w-full">
            {loading ? "Setting…" : "Set password"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
