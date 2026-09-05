"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function CreateOrganizationForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="rounded-xl border border-border p-4">
      <div className="mb-3">
        <div className="font-medium">Create client</div>
        <div className="text-sm text-muted-foreground">
          New organizations should only be created from the platform admin console.
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="CORTEX" />
        <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="cortex" />
      </div>
      {error ? <div className="mt-3 text-sm text-destructive">{error}</div> : null}
      <div className="mt-3">
        <Button
          type="button"
          disabled={isPending || !name.trim() || !slug.trim()}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              try {
                const response = await fetch("/api/orgs", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  credentials: "same-origin",
                  body: JSON.stringify({ name, slug }),
                });
                const payload = (await response.json().catch(() => null)) as
                  | { error?: string }
                  | null;
                if (!response.ok) {
                  throw new Error(payload?.error || "Failed to create organization.");
                }
                setName("");
                setSlug("");
                router.refresh();
              } catch (caughtError) {
                setError(
                  caughtError instanceof Error
                    ? caughtError.message
                    : "Failed to create organization.",
                );
              }
            });
          }}
        >
          {isPending ? "Creating…" : "Create organization"}
        </Button>
      </div>
    </div>
  );
}
