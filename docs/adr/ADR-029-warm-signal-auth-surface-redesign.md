# ADR-029: Warm Signal Auth Surface Redesign

**Status:** Accepted
**Date:** 2026-07-20
**Deciders:** Roland
**Related:** ADR-002 (native client authentication), ADR-018 (Tradepost native client), ADR-027 (consumer-client admission and self-serve signup), ADR-028 (per-client auth brand theming)

## Context

Engram owns the hosted login surfaces at `login.ctxhost.com` and
`login.dev.ctxhost.com`. The default (non-branded) auth shell — bare `/login`,
`/register`, and `/set-password` — currently renders the neutral shadcn token
set: slate/white gradients, system fonts, and the small Engram node mark. It is
correct and safe, but it reads as generic scaffolding rather than as the front
door to the CORTEX suite.

The suite has since converged on a shared visual language internally referred to
as **Warm Signal**: a warm-ink dark theme / warm-paper light theme built on
OKLCH color, Instrument Serif for display type, and Schibsted Grotesk for UI
type. This ADR adopts that language for Engram's default hosted auth surfaces
and adds two things the current shell lacks: a living mesh-constellation
signature mark with a subtle CSS-only ambient background and staggered entrance
animation, and a quiet CORTEX-mesh-family wordmark row (Synapse · Thoughts ·
Pulse) that signals the suite behind the login without turning the page into a
marketing surface.

Two alternative directions were surveyed and rejected. An **elevated neutral**
direction (keep the shadcn palette, add depth and motion only) was too timid to
distinguish the suite entry point. A **bold split-panel** direction
(full-bleed marketing panel beside the form) was too heavy for a login and
fought the single-column card layout the forms already use. Warm Signal was
chosen as the direction that gives the surface a distinct, on-brand identity
without restructuring the forms or the flow.

This redesign necessarily redefines the *default* Engram auth look that ADR-028
(per-client brand theming, merged the same day) treats as its baseline. ADR-028
scopes Tradepost's distinct treatment under `[data-brand-theme="tradepost"]`
selectors in `globals.css`, overriding the same shadcn semantic CSS custom
properties (`--background`, `--card`, `--primary`, …) that Warm Signal also
touches. The two must compose: Warm Signal is a new default for those shared
token names, and the Tradepost override must keep winning for `tradepost-web`
sessions, unchanged and pixel-for-pixel. Preserving ADR-028's invariants —
`data-brand-theme`, `brandThemeForClient()`, the Tradepost CSS block, and the
`(auth)/layout.tsx` font-loading pattern — is a hard constraint on this work,
not a nice-to-have.

Like ADR-028, this is a presentation-only redesign. No auth behavior changes.

## Decisions

### D1. Adopt the Warm Signal visual language for the default auth surfaces

The default (non-branded) auth shell adopts Warm Signal: a warm-ink dark theme
and a warm-paper light theme, OKLCH color, Instrument Serif for display type,
and Schibsted Grotesk for UI type. Scope is `/login`, `/register`, and
`/set-password` only. The exact OKLCH values, mark geometry, and keyframe
timings are implementation detail for the code PR, not fixed by this ADR; this
ADR fixes the direction and the contracts below.

### D2. Token strategy: scoped remap under `.mesh-auth-shell`, not a global retheme

The Warm Signal values are assigned to the **existing** shadcn semantic
variable names (`--background`, `--foreground`, `--card`, `--primary`, `--ring`,
`--border`, `--muted-foreground`, and related — the same names ADR-028's
Tradepost block overrides), but scoped under `.mesh-auth-shell` and
`.dark .mesh-auth-shell`, **not** global `:root` / `.dark`.

Every element inside the auth shell — which wraps login, register, and
set-password — picks up the warm values through normal CSS variable
inheritance, with no changes to the form markup. Everything outside the shell is
structurally unaffected by construction: `src/components/ui/{card,button,input,label}.tsx`
and every non-auth page continue to resolve the original neutral shadcn tokens
from `:root` / `.dark`, because those global blocks are left untouched.

Suite-wide adoption of Warm Signal tokens (promoting these values to `:root`)
is a plausible **future** ADR. It is explicitly out of scope here.

### D3. Cascade ordering guarantees Tradepost keeps winning, unchanged

The new Warm Signal token blocks are placed in `globals.css` **before** the
`[data-brand-theme="tradepost"]` section, at the same selector specificity the
Tradepost block already uses. Two independent mechanisms then guarantee
Tradepost is untouched:

1. **Source order.** `.mesh-auth-shell` and `[data-brand-theme="tradepost"]`
   are equal-specificity selectors (a class and an attribute selector, both
   0,1,0). Because the Warm Signal block comes first in source order, the later
   Tradepost declarations win the cascade for any token both define — for a
   `tradepost-web` session the shell renders `data-brand-theme="tradepost"` and
   its overrides apply on top.
2. **Structural scoping.** Warm Signal values live under `.mesh-auth-shell`, so
   non-auth consumers of the `ui/*` primitives never see them regardless of
   cascade order.
3. **Dark-tier redundancy invariant.** The source-order argument in (1) only
   settles ties between *equal-specificity* declarations. In dark mode the Warm
   Signal block is `.dark .mesh-auth-shell` (0,2,0) and Tradepost's dark block is
   `.dark [data-brand-theme="tradepost"]` (0,2,0) — equal to each other, so
   source order still decides. But both outrank Tradepost's undecorated light
   base block `[data-brand-theme="tradepost"]` (0,1,0): a token Warm Signal sets
   in `.dark .mesh-auth-shell` would beat a Tradepost value declared *only* in
   its light block, by specificity, regardless of source order. The implementer
   must therefore hold this invariant: any token Warm Signal sets in
   `.dark .mesh-auth-shell` that Tradepost also cares about must already be
   redeclared in Tradepost's own `.dark [data-brand-theme="tradepost"]` block
   (which today it is, for every color token). The implementation PR must
   preserve that redundancy — matching light-tier source order alone is not
   sufficient.

The implementation PR **must** capture before/after Tradepost screenshots in
both appearance modes as its regression gate; "the cascade should keep it
winning" is exactly the kind of claim that regresses silently.

### D4. Font loading extends the existing auth-only wrapper via `next/font/google`

Instrument Serif and Schibsted Grotesk load through `next/font/google` and
extend the **same** wrapper `<div>` in `src/app/(auth)/layout.tsx` that already
carries the ADR-028 Tradepost font variables (Fraunces / Archivo / Martian
Mono) — not a second wrapper. The new families route through the existing
`--font-sans-system` / `--font-display-system` indirection (see `globals.css`),
so nothing downstream needs to know the fonts changed; the shell simply resolves
warmer families through the same variable names.

Critically, the reassignment of `--font-sans-system` / `--font-display-system`
to the Warm Signal families happens **within the same `.mesh-auth-shell` /
`.dark .mesh-auth-shell` scope D2 establishes** — never at `:root`, where these
two properties currently live. `--font-sans-system` today feeds Tailwind's
global `--font-sans` via `@theme inline`, so a `:root` redeclaration would leak
the Warm Signal fonts app-wide and break D2's scoping guarantee and the Non-goals
line forbidding `:root` promotion. Scoping the font reassignment under
`.mesh-auth-shell` is what lets it compose with D2 rather than override globally.

Build implication: `next/font/google` fetches fonts at build time and so needs
outbound network access during the build. This is already true today for the
ADR-028 fonts, so it is not a new CI constraint.

### D5. Mesh-family wordmark row, gated server-side on `!securedByEngram`

The default hero renders a quiet uppercase wordmark row — **Synapse ·
Thoughts · Pulse**, those three products only, separated by small dots. No
Axon, no Gyrus, no tiles, no links; it is a signature, not navigation.

The gate is evaluated **server-side** in the login and register page
components as `showMeshFamily={!<resolved client config>.securedByEngram}` —
the local variable name differs per page (`initialClientConfig` in
`login/page.tsx`, `clientConfig` in `register/page.tsx`) — reusing the
`securedByEngram` boolean `auth-client-config.ts` already computes to
distinguish bare/default CORTEX auth from a resolved branded native client. It
is not a client-side check and not a CSS visibility trick. Consequences:

- Shown for bare `/login` and `/register`.
- Never shown for a resolved branded native client (Tradepost today, any
  future branded client), so a branded client never gets incidental CORTEX
  cross-promotion on its own sign-in surface.
- Never rendered on `/set-password` at all, regardless of `securedByEngram` —
  a password-activation step is not a place to advertise the suite.

### D6. Animation system contract — two independent CSS-only concerns

All motion is pure CSS. No JS animation library and no client JS driving frame
updates. Two independent concerns:

1. **Ambient decorative layer.** An `aria-hidden`, `pointer-events: none`
   decorative SVG constellation behind the content, with slow
   translation/opacity keyframes in the tens-of-seconds range and
   `will-change: transform`. Because it is aria-hidden and non-interactive, it
   never affects layout, focus order, or screen-reader output.
2. **One-time staggered entrance.** The mark, then the headline/copy block, then
   the card fade and slide in on load using `animation-delay` steps. This reuses
   the existing `fadeInUp` keyframe already in `globals.css` (introduced for the
   `.animate-fade-in-up` utility) rather than inventing a duplicate keyframe.

### D7. Reduced-motion contract is an accessibility requirement, not a nicety

A single `@media (prefers-reduced-motion: reduce)` block unconditionally kills
all `animation` properties on the ambient layer, the mark, and the entrance
classes, leaving every element in its final, fully-opaque, fully-positioned
state — no motion, no opacity dip, nothing clipped or hidden. This is the
mechanism by which the redesign meets WCAG 2.3.3 (Animation from Interactions)
motion-sensitivity expectations; it is a hard requirement of the design, not an
optional enhancement.

### D8. `/account` and `/admin` non-regression is a screenshot-gated guarantee

`/account` and `/admin` are out of scope and must render pixel-identically
before and after. They never render `AuthShell` and never consume
`.mesh-auth-shell` or any of the new tokens, so they are unaffected **by
construction**. The implementation PR must nonetheless capture explicit
before/after screenshots of both surfaces as a verification gate — "unaffected
by construction" is precisely the claim that regresses silently if a future
change widens a token block's scope.

## Non-goals

- No change to any `/api/auth/*` contract.
- No change to PKCE / redirect-target plumbing (`src/lib/redirect-target.ts`),
  `client_id` resolution, or `error=waitlist_required` handling.
- No change to the `.dark` class + `AppearanceToggle` localStorage mechanism;
  Warm Signal composes with the existing appearance preference exactly as
  ADR-028's theme does.
- No change to any shadcn `ui/*` primitive.
- No promotion of Warm Signal tokens to global `:root` / `.dark` (a possible
  future ADR).
- No DB-driven or operator-configurable theming; nothing in this ADR touches the
  ADR-028 registry mechanism.
- No change to `/account` or `/admin`.

## Consequences

### Positive

- The default suite entry point reads as intentional and on-brand rather than as
  neutral scaffolding, without restructuring the forms or the auth flow.
- Because the remap is scoped to `.mesh-auth-shell`, the blast radius is the
  auth shell only; the rest of the app is provably unaffected.
- ADR-028's Tradepost theme is preserved by two independent mechanisms (source
  order and structural scoping), so the two ship on the same shared token names
  without conflict.
- Reusing `securedByEngram` and the `fadeInUp` keyframe keeps the change
  additive — no new gating boolean, no duplicate animation primitive.
- The reduced-motion contract makes the motion accessible by default.

### Negative / trade-offs

- The auth surfaces now resolve different token values than the rest of the app,
  so "the login looks like the app" is deliberately no longer true until (if
  ever) a future ADR promotes Warm Signal suite-wide.
- Adds CSS surface area (ambient layer, entrance classes, a full scoped token
  block) that must be regression-tested in both appearance modes alongside the
  existing Tradepost block.
- The design depends on cascade source order between two equal-specificity
  blocks; a future reorder of `globals.css` sections could silently flip which
  block wins. Mitigated by D3's screenshot gate and a clear section comment.
- Two more Google-hosted font families load on the auth flow (still auth-only,
  still build-time fetched).

### Risks

- **Tradepost drift.** A Warm Signal declaration that is not overridden by the
  Tradepost block, or a source-order change, could alter Tradepost's login.
  Mitigation: keep Warm Signal before the Tradepost block at equal specificity,
  and gate the PR on before/after Tradepost screenshots in both modes.
- **Default-look leak.** A token accidentally written to `:root`/`.dark` instead
  of `.mesh-auth-shell` would retheme the whole app. Mitigation: all Warm Signal
  values live under the shell selector; verify a non-auth page screenshot.
- **Motion accessibility regression.** An animation added outside the
  reduced-motion block would bypass D7. Mitigation: the reduced-motion block
  must enumerate every animated selector, and reduced-motion rendering is part
  of the verification gate.
- **`/account` / `/admin` silent regression.** A later widening of a token
  block's scope could reach these routes. Mitigation: D8's screenshot gate.

## Implementation notes

Delivery ships as a **single** code PR (`feat/auth-warm-signal-ui`) built up
phase by phase as a draft and landing as one coherent visual unit rather than N
small PRs: fonts + tokens → AuthShell / mark / ambient / entrance → login →
register + set-password → tests / verification / finalize. This ADR is that
PR's prior and must merge before the code PR starts. The redesign builds
directly on ADR-028's substrate (`data-brand-theme`, `brandThemeForClient()`,
the Tradepost CSS block, and the `(auth)/layout.tsx` font pattern) and must not
disturb it.

Files expected to change:

- `src/app/globals.css` — new Warm Signal token blocks under `.mesh-auth-shell`
  / `.dark .mesh-auth-shell`, placed **before** the Tradepost section; ambient
  layer and entrance classes reusing the existing `fadeInUp` keyframe; the
  `@media (prefers-reduced-motion: reduce)` block.
- `src/components/auth/auth-shell.tsx` — replaces the existing span-based mesh
  mark (`mesh-auth-shell__mark-node--core/north/east/southwest`, ADR-028
  substrate) with an inline SVG constellation inside the preserved
  `.mesh-auth-shell__mark` container, adds the new ambient SVG layer and the
  new entrance-animation classes, and adds the `showMeshFamily` wordmark row.
- `src/app/(auth)/layout.tsx` — add Instrument Serif + Schibsted Grotesk via
  `next/font/google` on the existing auth wrapper (optionally factored into a
  small `src/lib/fonts.ts`), routed through the `--font-*-system` indirection.
- `src/app/(auth)/login/page.tsx` and `login-form.tsx` — pass
  `showMeshFamily={!initialClientConfig.securedByEngram}` from the server
  component (login's resolved config variable is `initialClientConfig`).
- `src/app/(auth)/register/page.tsx` — same server-side mesh-family gate.
- `src/app/(auth)/set-password/page.tsx` and `set-password-form.tsx` — adopt the
  shell restyle; never render the mesh-family row.

Verification gates for the PR: before/after Tradepost screenshots in both
appearance modes (D3); before/after `/account` and `/admin` screenshots (D8);
reduced-motion rendering of all three in-scope surfaces (D7); and a non-auth
page screenshot confirming no token leak (D2).

## Links

- ADR-028: Per-Client Auth Brand Theming —
  `docs/adr/ADR-028-per-client-auth-brand-theming.md`
- ADR-027: Consumer-Client Admission and Self-Serve Signup —
  `docs/adr/ADR-027-consumer-client-admission-and-self-serve-signup.md`
- ADR-018: Tradepost Native Client — `docs/adr/ADR-018-tradepost-native-client.md`
- ADR-002: Native Client Authentication —
  `docs/adr/ADR-002-native-client-authentication.md`
- Auth shell entry point — `src/components/auth/auth-shell.tsx`
- Auth-only font scope — `src/app/(auth)/layout.tsx`
- Shared tokens, shell CSS, and Tradepost theme block — `src/app/globals.css`
- Client config + `securedByEngram` — `src/lib/auth-client-config.ts`
- Brand theme registry — `src/lib/auth-brand-theme.ts`
