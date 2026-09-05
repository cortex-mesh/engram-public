# Engram Auth Warm Signal Checkpoint

**Date:** 2026-07-21
**Goal prompt:** meta repo
`docs/plans/2026-07-20-engram-auth-warm-signal-goal-prompt.md`

## Shipped

- `docs/adr/ADR-029-warm-signal-auth-surface-redesign.md` ratifies the Warm
  Signal visual language for Engram's default (non-branded) hosted auth
  surfaces: the `.mesh-auth-shell`-scoped token remap and its cascade-order
  contract against ADR-028's Tradepost theme, the server-side
  `!securedByEngram` mesh-family gate, the CSS-only ambient + entrance
  animation system and its `prefers-reduced-motion` contract, the font-loading
  mechanism, and the `/account`/`/admin` non-regression guarantee.
- `/login`, `/register`, `/set-password` restyled to Warm Signal: warm-ink
  dark / warm-paper light OKLCH tokens, Instrument Serif display type,
  Schibsted Grotesk UI type, an inline SVG constellation mark (replacing the
  old span-based glyph) with a faint ambient decorative layer, a quiet
  `Synapse · Thoughts · Pulse` mesh-family row, and copy dedup (the
  branded-tagline duplication in the login card description is gone).
- Both `/login` and `/register` resolve their brand config, theme, and the
  mesh-family gate **server-side** via `resolveClientConfigFromSearchParams` —
  `/set-password` already worked this way; `/register` did not until this
  work (see Surprises).
- `brandLogoUrl` is now actually wired from all three pages to `AuthShell`
  (the prop and rendering path landed early but were dead until wired).
- Tradepost (`tradepost-web`, ADR-028) keeps its own wordmark, no ambient
  layer, no entrance animation, and no mesh-family row — by construction
  (JSX branch), not just CSS override — and its font, letter-spacing, and
  color tokens are provably isolated from the new Warm Signal token set via
  `:not([data-brand-theme="tradepost"])` scoping.

## PRs / ADRs

- ADR: https://github.com/cortex-mesh/engram/pull/184 (merged, `cf390ad`)
- Redesign (all 5 implementation phases, one PR): https://github.com/cortex-mesh/engram/pull/185
  (merged, `f45f8c8`; engram bumped to v0.51.0 same release)
- Related, not part of this PR: https://github.com/cortex-mesh/engram/pull/186
  (prod DB migration verify/apply-via-bastion runbook — used separately to
  apply a live Tradepost `brandTagline` data update to prod; not this goal's
  scope, noted here only because it landed in the same release window)

## Controller review

This PR went through **two controller review rounds** before merge, on top of
the mandatory per-push Opus subprocess reviews already run during
implementation:

**Round 1 — REVISE, 9 confirmed findings (1 blocking):**

- **Blocking:** `/register` computed its mesh-family gate **client-side**
  (`"use client"`, `useEffect` fetch, fallback to `DEFAULT_CONFIG` on any
  failure) — a transient `/api/auth/client-config` error would fail the gate
  **open**, rendering the CORTEX mesh-family row and copy on a branded
  production registration page. Fixed by splitting `/register` into a server
  component (resolves config via `resolveClientConfigFromSearchParams`,
  mirroring `/login` exactly) plus a client form component that receives the
  resolved config as a prop. The gate can no longer depend on a client fetch
  outcome.
- **Important:** the `--font-sans-system` token redeclaration was inert —
  nothing actually consumed it as an active `font-family` (the app's real
  font-family resolves once, at the `<html>` element, an *ancestor* of the
  scoped rule, so the descendant redefinition was never consulted). Fixed by
  adding an explicit `font-family` declaration on the same scoped rule,
  verified via computed style rather than markup. Also: `letter-spacing:
  -0.01em` on the new headline class leaked into Tradepost's hero (Tradepost's
  override redeclares font/size/weight/line-height but not letter-spacing, so
  with no competing value for that one property, the new rule won despite
  lower overall specificity) — fixed by scoping the whole rule
  `:not([data-brand-theme="tradepost"])`. Also: the existing
  mesh-family-gate negative test used `tradepost-web`, which is independently
  suppressed by `AuthShell`'s own defense-in-depth guard regardless of
  whether the server-side gate works — added a second negative test with a
  non-Tradepost branded client id and mutation-tested it (hardcoded the gate
  to `true`, confirmed the new test fails, reverted).
- **Minor:** a brand-neutral tagline fallback for branded clients missing
  their own DB tagline (previously fell back to the CORTEX-flavored default
  copy); an ARIA-prohibited `aria-label` on a `<p>` replaced with an
  `sr-only` text prefix; an unused italic font style dropped; a new
  `register-page.test.ts` mirroring `login-page.test.ts`.

**Requested Opus sanity pass on the round-1 fix — 6 more findings (not part
of the original 9), 5 fixed:**

- The round-1 fix for `/register` left its *old* client-side config re-fetch
  in place "for freshness," but that effect had drifted from `/login`'s
  equivalent (it never forwarded `redirect_uri`/the opaque redirect-target
  param) — a branded `/register` reached via a nested `redirect_uri` could
  silently downgrade the card back to CORTEX defaults post-hydration, while
  the server-rendered hero stayed correctly branded, a visible mismatch. Not
  patched — **deleted**: Next.js App Router re-runs the server component on
  every navigation to the route (full load or `<Link>`), so the client
  re-fetch was redundant on top of being buggy.
- `--mesh-accent`/`--mesh-human` were the only two tokens the base
  `.mesh-auth-shell` rule sets that Tradepost's own block doesn't redeclare —
  scoped into the existing exclusion rule (light + dark), currently inert
  only by coincidence that every consumer happened to already be separately
  scoped or unrendered for Tradepost.
- `/set-password`'s `generateMetadata` description used the raw
  `brandTagline` while the visible hero overrides it to "Almost there." for
  non-branded visitors — the page's `<meta description>` and its on-screen
  headline disagreed. Fixed to share the same value.
- Dismissed (both rounds, same reasoning): `will-change: transform` on the
  ambient decorative layers — these animate continuously and infinitely for
  the page's lifetime, so permanently promoting them to their own compositor
  layer is the correct pattern, not a stale hint.
- Flagged, not fixed: the default tagline string/`DEFAULT_CONFIG` shape is
  still duplicated across three files (down from four after the redundant
  register re-fetch was deleted). Real but explicitly lower-priority
  cleanup, deferred rather than expanding an already-large review-fix diff
  into an unplanned shared-constants refactor.

## Verification

Local gates (every phase and both review-fix rounds): `npm run lint`,
`npm run typecheck`, `npm test`, `npm run build`, `npm audit`. Final state:
680/680 tests green (7 new this goal), 0 vulnerabilities.

Playwright screenshot passes, both appearance modes, read locally (not
committed as artifacts): default `/login` desktop + 390px mobile; `/register`
default + Tradepost; `/set-password` form + missing-token state; keyboard-only
tab pass confirming a visible focus ring on every control including the newly
focus-visible magic-link toggle; `prefers-reduced-motion` computed-style check
confirming `animationName` resolves to `"none"` on every animated selector.

**Tradepost pixel-diff against a `main`-baseline worktree** (commit `cf390ad`,
pre-redesign, via `pixelmatch`): both appearance modes show ~3–4% pixel
difference, uniform and vertical (everything below the card description
shifts up by one line height) — fully explained by the intentional D6
tagline-dedup fix (the appended duplicate tagline is removed from the shared
login card description, and `login-form.tsx` is shared between both themes).
Re-ran this diff after every subsequent CSS fix in both controller review
rounds; the count never changed, confirming each fix was a true no-op for
Tradepost's actual rendering — every leak this goal found and fixed
(`--font-sans-system`, `letter-spacing`, `--mesh-accent`/`--mesh-human`) was
latent/provably-fragile rather than currently visible, because Tradepost's
own CSS already independently owned the properties in question. Tradepost's
**theme** (colors, fonts, gradients, layout chrome) is pixel-identical to
pre-redesign; its **card copy** carries the one intentional duplicate-text
fix.

`/account` and `/admin` were verified unaffected **by construction** rather
than by authenticated screenshot: the full diff touches 13 files, all under
`(auth)/`, `components/auth/`, `lib/auth-client-config.ts`, `lib/fonts.ts`,
and `globals.css` (itself scoped to the `.mesh-auth-shell` class, which only
`AuthShell` applies); neither route renders `AuthShell` or references any
touched CSS class, and no shared `ui/*` primitive was touched.

Prod: per the controller, engram v0.51.0 is live on `login.ctxhost.com` and
`auth.ccgtradepost.com` carrying this redesign; Tradepost verified pixel-stable
in both appearance modes on the live surface, default CORTEX login shows the
full Warm Signal treatment. Prod verification is the controller's own step
per this goal's workflow (dev/CI verification was this session's
responsibility; prod promotion and its verification are human-only).

## Surprises

- SVG `<polyline>` defaults to filling its implied closed shape — the ambient
  layer's "faint decorative lines" initially rendered as solid triangles
  until an explicit `fill: none` was added. Caught by screenshot, not by
  code review or typecheck.
- Tailwind v4's own utility-class layer always loses to unlayered author CSS
  regardless of specificity or source order — this is what let a plain
  `.mesh-auth-shell__headline` rule in `globals.css` safely override the
  pre-existing Tailwind `text-lg` utility class on the same element (kept
  deliberately, since Tradepost's own CSS also targets `.text-lg`) without
  `!important`.
- The most consequential surprise was architectural, not visual: converting
  `/register` from a fully client-rendered page to a server-resolved one (to
  fix the blocking client-side-gate finding) surfaced that its "keep the
  client fetch for freshness" instinct was actively harmful once the server
  became authoritative — dead code that used to be load-bearing can become a
  liability rather than a no-op once a fix changes the surrounding data-flow
  contract, and deserves the same scrutiny as new code, not a pass because it
  predates the change.
- A separate, unrelated CI hiccup mid-implementation: the `npm audit`
  gate started failing on a newly-published advisory against an *existing*
  `package.json` `overrides` pin (`brace-expansion`, pinned to exactly the
  version the new advisory flagged) — confirmed via `git diff
  origin/main...HEAD -- package.json package-lock.json` being empty before
  the fix, i.e. definitively not caused by this branch. Bumped the pin and
  one more dev-only transitive (`js-yaml`) past their advisories.

## Status

All 5 implementation phases plus the ADR are shipped, merged, and — per the
controller — live on aws-prod. This closes the goal; no further phases follow.
