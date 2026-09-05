"use client"

import { useMemo, useState } from "react"
import { useSearchParams } from "next/navigation"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardFooter } from "@/components/ui/card"
import { AuthCardIntro } from "@/components/auth/auth-card-intro"

interface AuthClientConfig {
  clientId: string | null
  brandName: string
  brandTagline: string
  brandLogoUrl: string | null
  signupMode: "waitlist" | "open"
  securedByEngram: boolean
}

const COLLECTION_BRACKETS = ["Under 1,000 cards", "1,000-5,000 cards", "5,000-20,000 cards", "20,000+ cards"]
const FORMAT_OPTIONS = ["Commander", "Modern", "Pioneer", "Standard", "Limited", "Pauper"]
const GOAL_OPTIONS = ["Collection tracking", "Deck building", "Trading"]

export function RegisterForm({ initialClientConfig }: { initialClientConfig: AuthClientConfig }) {
  const searchParams = useSearchParams()

  const initialEmail = useMemo(
    () => searchParams.get("email") || "",
    [searchParams],
  )
  const waitlistError = searchParams.get("error")

  // The server already resolved the full client config for this exact URL
  // (including a client_id nested inside redirect_uri) — no client-side
  // re-fetch needed, and any App Router navigation to this route (full load
  // or <Link>) re-runs the server component with a fresh URL anyway.
  const clientConfig = initialClientConfig
  const [name, setName] = useState("")
  const [email, setEmail] = useState(initialEmail)
  const [password, setPassword] = useState("")
  const [collectionSizeBracket, setCollectionSizeBracket] = useState("")
  const [formatsPlayed, setFormatsPlayed] = useState<string[]>([])
  const [tradepostGoals, setTradepostGoals] = useState<string[]>([])
  const [priorityNote, setPriorityNote] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  function toggleValue(value: string, selected: string[], setter: (next: string[]) => void) {
    setter(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value])
  }

  async function handleWaitlistSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    setLoading(true)
    const showTradepostEnrichment = clientConfig.clientId === "tradepost-web"

    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: name,
          email,
          clientId: clientConfig.clientId,
          collectionSizeBracket: showTradepostEnrichment ? collectionSizeBracket || undefined : undefined,
          formatsPlayed: showTradepostEnrichment ? formatsPlayed : [],
          tradepostGoals: showTradepostEnrichment ? tradepostGoals : [],
          priorityNote: showTradepostEnrichment ? priorityNote : undefined,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        setError(data.error || "Waitlist request failed")
        return
      }

      setSubmitted(true)
    } catch {
      setError("Something went wrong. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  async function handleOpenSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    setLoading(true)

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: name,
          email,
          password,
          clientId: clientConfig.clientId,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        setError(data.error || "Account creation failed")
        return
      }

      setSubmitted(true)
    } catch {
      setError("Something went wrong. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  const openMode = clientConfig.signupMode === "open"
  const showTradepostEnrichment = clientConfig.clientId === "tradepost-web"

  return (
    <Card className="border-border/70 bg-card/95 shadow-xl shadow-black/5 backdrop-blur-sm">
      <div className="px-6 pt-6">
        <AuthCardIntro
          eyebrow={openMode ? "Create account" : "Request access"}
          title={openMode ? `Create your ${clientConfig.brandName} account` : `Join the ${clientConfig.brandName} waitlist`}
          description={
            openMode
              ? "Create an identity-only account. You must verify your email before you can sign in."
              : showTradepostEnrichment
                ? `${clientConfig.brandTagline} Help us prioritize your invite; email alone is enough.`
                : "Self-service account creation is disabled. Request access and we will follow up when your workspace is ready."
          }
        />
      </div>
      <CardContent className="space-y-4 pt-6">
      {waitlistError === "waitlist_required" && !submitted && (
        <div className="mesh-notice mb-4 rounded-md bg-primary/10 px-3 py-2 text-sm text-primary">
          Your sign-in method is not enabled for automatic account creation. Join the waitlist and we&apos;ll contact you when access is available.
        </div>
      )}

      {submitted ? (
        <div className="mesh-notice rounded-md bg-primary/10 px-3 py-4 text-sm text-primary">
          {openMode
            ? "Check your email to verify your account before signing in."
            : `Thanks — we received your ${clientConfig.brandName} waitlist request.`}
        </div>
      ) : (
        <form onSubmit={openMode ? handleOpenSubmit : handleWaitlistSubmit} className="flex flex-col gap-4">
          {error && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="name">Display name</Label>
            <Input
              id="name"
              type="text"
              placeholder="Jane Doe"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>

          {openMode ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                maxLength={72}
                required
                autoComplete="new-password"
              />
            </div>
          ) : showTradepostEnrichment ? (
            <div className="space-y-3 rounded-lg border border-border p-3">
              <div className="space-y-1">
                <Label htmlFor="collection-size">Collection size</Label>
                <select
                  id="collection-size"
                  value={collectionSizeBracket}
                  onChange={(event) => setCollectionSizeBracket(event.target.value)}
                  className="border-input dark:bg-input/30 h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <option value="">Prefer not to say</option>
                  {COLLECTION_BRACKETS.map((value) => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <Label>Formats played</Label>
                <div className="flex flex-wrap gap-2">
                  {FORMAT_OPTIONS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => toggleValue(value, formatsPlayed, setFormatsPlayed)}
                      aria-pressed={formatsPlayed.includes(value)}
                      className={`rounded-full border px-3 py-1 text-xs outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 ${formatsPlayed.includes(value) ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <Label>What do you want from Tradepost?</Label>
                <div className="flex flex-wrap gap-2">
                  {GOAL_OPTIONS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => toggleValue(value, tradepostGoals, setTradepostGoals)}
                      aria-pressed={tradepostGoals.includes(value)}
                      className={`rounded-full border px-3 py-1 text-xs outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 ${tradepostGoals.includes(value) ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1">
                <Label htmlFor="priority-note">Why are you interested?</Label>
                <textarea
                  id="priority-note"
                  value={priorityNote}
                  onChange={(event) => setPriorityNote(event.target.value)}
                  maxLength={500}
                  rows={3}
                  className="border-input dark:bg-input/30 min-h-20 w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                />
              </div>
            </div>
          ) : null}

          <Button type="submit" disabled={loading} className="w-full">
            {loading ? "Submitting…" : openMode ? "Create account" : "Request access"}
          </Button>
        </form>
      )}
      </CardContent>
      <CardFooter className="flex-col justify-center gap-2">
      <p className="text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link
          href={`/login${clientConfig.clientId ? `?client_id=${encodeURIComponent(clientConfig.clientId)}` : ""}`}
          className="text-primary underline-offset-4 hover:underline"
        >
          Sign in
        </Link>
      </p>
      {clientConfig.securedByEngram ? (
        <p className="text-xs text-muted-foreground">Secured by Engram</p>
      ) : null}
      </CardFooter>
    </Card>
  )
}
