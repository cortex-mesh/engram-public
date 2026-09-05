"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export default function EntitlementToggle({
  endpoint,
  body,
  enabled,
  label,
  disabled = false,
}: {
  endpoint: string;
  body: Record<string, unknown>;
  enabled: boolean;
  label: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => {
          setError(null);
          startTransition(async () => {
            try {
              const response = await fetch(endpoint, {
                method: "PUT",
                headers: {
                  "Content-Type": "application/json",
                },
                credentials: "same-origin",
                body: JSON.stringify({ ...body, enabled: !enabled }),
              });

              if (!response.ok) {
                const payload = (await response.json().catch(() => null)) as
                  | { error?: string }
                  | null;
                throw new Error(payload?.error || `Failed to update ${label}.`);
              }

              router.refresh();
            } catch (caughtError) {
              setError(
                caughtError instanceof Error ? caughtError.message : `Failed to update ${label}.`,
              );
            }
          });
        }}
        disabled={disabled || isPending}
        className={[
          "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
          enabled
            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
            : "border-border bg-muted text-muted-foreground",
          disabled
            ? "cursor-not-allowed opacity-60"
            : isPending
              ? "cursor-wait opacity-70"
              : "hover:bg-accent hover:text-foreground",
        ].join(" ")}
      >
        {isPending ? "Saving…" : enabled ? "Enabled" : "Disabled"}
      </button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}
