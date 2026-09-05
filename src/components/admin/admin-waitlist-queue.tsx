"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import type { AdminWaitlistPage, AdminWaitlistRequest } from "@/lib/admin-console";

type ClientFilter = "all" | "tradepost-web" | "suite";
type EnrichmentFilter = "all" | "enriched" | "empty";
type VisibilityFilter = "visible" | "hidden" | "all";
type SortMode = "newest" | "oldest" | "enriched" | "repeat";

const TEST_DOMAINS = ["example.com", "1secmail.com", "web-library.net", "ctxhost.local"];
const MAX_APPROVAL_BATCH = 50;

function clientGroup(clientId: string | null): "tradepost-web" | "suite" {
  return clientId === "tradepost-web" ? "tradepost-web" : "suite";
}

function clientLabel(clientId: string | null): string {
  if (clientId === "tradepost-web") return "tradepost-web";
  return clientId ? `suite · ${clientId}` : "suite";
}

function hasEnrichment(request: AdminWaitlistRequest): boolean {
  return Boolean(
    request.collectionSizeBracket ||
      request.formatsPlayed.length ||
      request.tradepostGoals.length ||
      request.priorityNote?.trim(),
  );
}

function isLikelyTest(request: AdminWaitlistRequest): boolean {
  const domain = request.email.split("@").at(1)?.toLowerCase() ?? "";
  return TEST_DOMAINS.includes(domain);
}

function isEmailBlocked(request: AdminWaitlistRequest): boolean {
  return Boolean(request.suppression) || request.emailHygieneStatus !== "accepted";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function chipClass(tone: "neutral" | "good" | "warn" = "neutral"): string {
  const tones = {
    neutral: "border-border bg-muted/40 text-muted-foreground",
    good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    warn: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200",
  };
  return `inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`;
}

export default function AdminWaitlistQueue({ page }: { page: AdminWaitlistPage }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requests = page.requests;
  const [selected, setSelected] = useState<string[]>([]);
  const [clientFilter, setClientFilter] = useState<ClientFilter>("all");
  const [enrichmentFilter, setEnrichmentFilter] = useState<EnrichmentFilter>("all");
  const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>(page.visibility);
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [confirming, setConfirming] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const clientGroups = useMemo(
    () => Array.from(new Set(requests.map((request) => clientGroup(request.clientId)))).sort(),
    [requests],
  );

  const visibleRequests = useMemo(() => {
    const filtered = requests.filter((request) => {
      if (clientFilter !== "all" && clientGroup(request.clientId) !== clientFilter) return false;
      if (enrichmentFilter === "enriched" && !hasEnrichment(request)) return false;
      if (enrichmentFilter === "empty" && hasEnrichment(request)) return false;
      if (visibilityFilter === "visible" && request.hiddenAt) return false;
      if (visibilityFilter === "hidden" && !request.hiddenAt) return false;
      return true;
    });
    return filtered.sort((left, right) => {
      if (sortMode === "oldest") return Date.parse(left.createdAt) - Date.parse(right.createdAt);
      if (sortMode === "repeat") {
        const repeatDelta = right.requestCount - left.requestCount;
        if (repeatDelta !== 0) return repeatDelta;
        return Date.parse(right.lastRequestedAt) - Date.parse(left.lastRequestedAt);
      }
      if (sortMode === "enriched") {
        const enrichmentDelta = Number(hasEnrichment(right)) - Number(hasEnrichment(left));
        if (enrichmentDelta !== 0) return enrichmentDelta;
      }
      return Date.parse(right.createdAt) - Date.parse(left.createdAt);
    });
  }, [clientFilter, enrichmentFilter, requests, sortMode, visibilityFilter]);

  const selectableIds = useMemo(
    () => new Set(visibleRequests.filter((request) => !request.approvedAt && !request.hiddenAt && !isEmailBlocked(request)).map((request) => request.id)),
    [visibleRequests],
  );
  const selectedRequests = useMemo(
    () => requests.filter((request) => selected.includes(request.id) && !request.approvedAt && !request.hiddenAt && !isEmailBlocked(request)),
    [requests, selected],
  );
  const selectedEmails = selectedRequests.map((request) => request.email);
  const pendingVisible = visibleRequests.filter((request) => !request.approvedAt && !request.hiddenAt).length;

  function toggle(id: string) {
    if (!selectableIds.has(id)) return;
    setConfirming(false);
    if (!selected.includes(id) && selected.length >= MAX_APPROVAL_BATCH) {
      setMessage(`Approval batches are capped at ${MAX_APPROVAL_BATCH} people. Send this batch before selecting more.`);
      return;
    }
    setSelected((current) => {
      if (current.includes(id)) return current.filter((value) => value !== id);
      return [...current, id];
    });
  }

  function selectVisiblePending() {
    setConfirming(false);
    const pendingIds = visibleRequests
      .filter((request) => !request.approvedAt && !request.hiddenAt && !isEmailBlocked(request))
      .map((request) => request.id);
    setSelected(pendingIds.slice(0, MAX_APPROVAL_BATCH));
    if (pendingIds.length > MAX_APPROVAL_BATCH) {
      setMessage(`Selected the first ${MAX_APPROVAL_BATCH} pending people. Approval batches are capped at ${MAX_APPROVAL_BATCH}.`);
    }
  }

  function clearSelection() {
    setConfirming(false);
    setSelected([]);
  }

  function serverVisibilityHref(nextVisibility: VisibilityFilter): string {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("cursor");
    if (nextVisibility === "visible") params.delete("visibility");
    else params.set("visibility", nextVisibility);
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
  }

  function nextPageHref(): string {
    const params = new URLSearchParams(searchParams.toString());
    if (page.visibility === "visible") params.delete("visibility");
    else params.set("visibility", page.visibility);
    if (page.nextCursor) params.set("cursor", page.nextCursor);
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
  }

  function changeVisibility(nextVisibility: VisibilityFilter) {
    setVisibilityFilter(nextVisibility);
    clearSelection();
    router.push(serverVisibilityHref(nextVisibility));
  }

  function approveSelected() {
    setError(null);
    setMessage(null);

    startTransition(async () => {
      try {
        const response = await fetch("/api/admin/waitlist/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ ids: selectedRequests.map((request) => request.id), confirmEmails: selectedEmails }),
        });
        const payload = (await response.json().catch(() => null)) as
          | { error?: string; approved?: number }
          | null;
        if (!response.ok) {
          throw new Error(payload?.error || "Failed to approve waitlist requests.");
        }
        setSelected([]);
        setConfirming(false);
        setMessage(`Approved ${payload?.approved ?? 0} request(s).`);
        router.refresh();
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : "Failed to approve requests.");
      }
    });
  }

  function setHidden(request: AdminWaitlistRequest, hidden: boolean) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      try {
        const response = await fetch(`/api/admin/waitlist/${request.id}/visibility`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            hidden,
            reason: hidden ? `Marked as test/junk (${request.email})` : "Restored to waitlist queue",
          }),
        });
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        if (!response.ok) {
          throw new Error(payload?.error || "Failed to update waitlist visibility.");
        }
        setSelected((current) => current.filter((id) => id !== request.id));
        setConfirming(false);
        setMessage(hidden ? `Hidden ${request.email}.` : `Restored ${request.email}.`);
        router.refresh();
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : "Failed to update waitlist visibility.");
      }
    });
  }

  return (
    <div className="space-y-5">
      {error ? <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}
      {message ? <div className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary">{message}</div> : null}

      <div className="grid gap-3 rounded-lg border border-border bg-muted/20 p-3 lg:grid-cols-[1fr_auto]">
        <div className="grid gap-3 md:grid-cols-4">
          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            <span>Client</span>
            <select
              value={clientFilter}
              onChange={(event) => {
                setClientFilter(event.target.value as ClientFilter);
                clearSelection();
              }}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
            >
              <option value="all">All clients</option>
              {clientGroups.includes("tradepost-web") ? <option value="tradepost-web">tradepost-web</option> : null}
              {clientGroups.includes("suite") ? <option value="suite">suite</option> : null}
            </select>
          </label>
          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            <span>Enrichment</span>
            <select
              value={enrichmentFilter}
              onChange={(event) => {
                setEnrichmentFilter(event.target.value as EnrichmentFilter);
                clearSelection();
              }}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
            >
              <option value="all">All requests</option>
              <option value="enriched">Has enrichment</option>
              <option value="empty">No enrichment</option>
            </select>
          </label>
          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            <span>Visibility</span>
            <select
              value={visibilityFilter}
              onChange={(event) => {
                changeVisibility(event.target.value as VisibilityFilter);
              }}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
            >
              <option value="visible">Visible queue</option>
              <option value="hidden">Hidden test/junk</option>
              <option value="all">All rows</option>
            </select>
          </label>
          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            <span>Sort</span>
            <select
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value as SortMode)}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
            >
              <option value="newest">Newest signup first</option>
              <option value="oldest">Oldest signup first</option>
              <option value="enriched">Enriched first</option>
              <option value="repeat">Repeat interest first</option>
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-2 lg:justify-end">
          <div className="text-sm text-muted-foreground">
            {pendingVisible} pending visible · {visibleRequests.length} shown · {requests.length} loaded
            {page.nextCursor ? " · more available" : ""}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" disabled={isPending || pendingVisible === 0} onClick={selectVisiblePending}>
              Select visible
            </Button>
            <Button type="button" variant="outline" disabled={isPending || selected.length === 0} onClick={clearSelection}>
              Clear
            </Button>
          </div>
        </div>
      </div>

      {page.nextCursor ? (
        <div className="flex justify-end">
          <Link className="text-sm font-medium text-primary underline-offset-4 hover:underline" href={nextPageHref()}>
            Next {page.pageSize} waitlist rows
          </Link>
        </div>
      ) : null}

      {selectedRequests.length > 0 ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          {!confirming ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-medium text-amber-900 dark:text-amber-100">
                  {selectedRequests.length} selected for approval
                </div>
                <div className="text-amber-800/80 dark:text-amber-100/80">
                  Approval sends set-password email to real people. Sent email cannot be undone.
                </div>
              </div>
              <Button type="button" disabled={isPending} onClick={() => setConfirming(true)}>
                Review email recipients
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <div className="font-semibold text-amber-950 dark:text-amber-50">
                  Confirm emailing {selectedRequests.length} real {selectedRequests.length === 1 ? "person" : "people"}
                </div>
                <div className="text-amber-900/80 dark:text-amber-100/80">
                  These exact addresses will receive account activation email. There is no undo after send:
                </div>
              </div>
              <ul className="max-h-48 overflow-auto rounded-md border border-amber-500/30 bg-background/70 p-2 font-mono text-xs">
                {selectedEmails.map((email) => (
                  <li key={email} className="py-0.5">{email}</li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-2">
                <Button type="button" disabled={isPending} onClick={approveSelected}>
                  {isPending ? "Sending…" : `Send ${selectedRequests.length} approval email${selectedRequests.length === 1 ? "" : "s"}`}
                </Button>
                <Button type="button" variant="outline" disabled={isPending} onClick={() => setConfirming(false)}>
                  Back
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : null}

      <div className="grid gap-3">
        {visibleRequests.length === 0 ? (
          <div className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">
            No waitlist requests match these filters.
          </div>
        ) : null}
        {visibleRequests.map((request) => {
          const enriched = hasEnrichment(request);
          const testLike = isLikelyTest(request);
          const approved = Boolean(request.approvedAt);
          const hidden = Boolean(request.hiddenAt);
          const blocked = isEmailBlocked(request);
          const selectable = selectableIds.has(request.id);
          return (
            <article
              key={request.id}
              className={`rounded-xl border p-4 shadow-sm ${
                hidden ? "border-dashed border-muted-foreground/40 bg-muted/30 opacity-75" : "border-border bg-card"
              }`}
            >
              <div className="grid gap-4 lg:grid-cols-[minmax(15rem,20rem)_1fr_auto]">
                <div className="space-y-3">
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      disabled={!selectable}
                      checked={selected.includes(request.id)}
                      onChange={() => toggle(request.id)}
                      className="mt-1 size-4 rounded border-border accent-primary"
                      aria-label={`Select ${request.email}`}
                    />
                    <div className="min-w-0">
                      <div className="truncate font-semibold">{request.displayName || "No name"}</div>
                      <div className="break-all text-sm text-muted-foreground">{request.email}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Signed up {formatDate(request.createdAt)}
                        {request.requestCount > 1 ? ` · last ${formatDate(request.lastRequestedAt)}` : ""}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <span className={chipClass()}>{clientLabel(request.clientId)}</span>
                    <span className={chipClass(request.requestCount > 1 ? "warn" : "neutral")}>
                      {request.requestCount} request{request.requestCount === 1 ? "" : "s"}
                    </span>
                    <span className={chipClass(enriched ? "good" : "neutral")}>
                      {enriched ? "has enrichment" : "no enrichment"}
                    </span>
                    {testLike ? <span className={chipClass("warn")}>likely test</span> : null}
                    {request.suppression ? <span className={chipClass("warn")}>suppressed</span> : null}
                    {!request.suppression && request.emailHygieneStatus !== "accepted" ? (
                      <span className={chipClass("warn")}>email blocked</span>
                    ) : null}
                    {hidden ? <span className={chipClass("warn")}>hidden</span> : null}
                    {approved ? <span className={chipClass("good")}>approved</span> : null}
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-3">
                  <SignalBlock label="Collection size" empty="Not provided">
                    {request.collectionSizeBracket || null}
                  </SignalBlock>
                  <SignalBlock label="Formats" empty="No formats">
                    {request.formatsPlayed.length ? request.formatsPlayed.join(", ") : null}
                  </SignalBlock>
                  <SignalBlock label="Goals" empty="No goals">
                    {request.tradepostGoals.length ? request.tradepostGoals.join(", ") : null}
                  </SignalBlock>
                  <div className="rounded-lg border border-border/70 bg-muted/20 p-3 md:col-span-3">
                    <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Note</div>
                    {request.priorityNote ? (
                      <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">{request.priorityNote}</p>
                    ) : (
                      <p className="text-sm text-muted-foreground">No note</p>
                    )}
                  </div>
                </div>

                <div className="flex flex-row flex-wrap items-start gap-2 lg:w-40 lg:flex-col">
                  <div className="text-xs text-muted-foreground">
                    {approved && request.approvedAt ? `Approved ${formatDate(request.approvedAt)}` : "Pending"}
                  </div>
                  {blocked ? (
                    request.suppression ? (
                      <div className="max-w-44 text-xs text-destructive">
                        Suppressed: {request.suppression.reason}
                        {request.suppression.eventType ? ` (${request.suppression.eventType})` : ""}
                      </div>
                    ) : (
                      <div className="max-w-44 text-xs text-destructive">
                        Email blocked: {request.emailHygieneReason || request.emailHygieneStatus}
                      </div>
                    )
                  ) : request.confirmationEmailSuppressedAt ? (
                    <div className="max-w-44 text-xs text-destructive">Confirmation not sent</div>
                  ) : null}
                  {hidden && request.hiddenReason ? (
                    <div className="max-w-44 text-xs text-muted-foreground">{request.hiddenReason}</div>
                  ) : null}
                  {!approved ? (
                    hidden ? (
                      <Button type="button" variant="outline" disabled={isPending} onClick={() => setHidden(request, false)}>
                        Unhide
                      </Button>
                    ) : (
                      <Button type="button" variant="outline" disabled={isPending} onClick={() => setHidden(request, true)}>
                        Hide test/junk
                      </Button>
                    )
                  ) : null}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function SignalBlock({
  label,
  empty,
  children,
}: {
  label: string;
  empty: string;
  children: string | null;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      {children ? <div className="text-sm font-medium">{children}</div> : <div className="text-sm text-muted-foreground">{empty}</div>}
    </div>
  );
}
