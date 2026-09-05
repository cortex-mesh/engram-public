# ADR-028: Per-Client Auth Brand Theming

**Status:** Accepted
**Date:** 2026-07-20
**Deciders:** Roland
**Related:** ADR-002 (native client authentication), ADR-010 (consumer app admission pattern), ADR-018 (Tradepost native client), ADR-027 (consumer-client admission and self-serve signup)

## Context

Engram owns the hosted login surfaces at `login.ctxhost.com` and
`login.dev.ctxhost.com`. Suite apps and consumer apps both bounce through that
shared host for login, registration, provider sign-in, magic-link flows, and
set-password flows.

The shared auth shell currently looks like Engram/CORTEX: slate-blue gradients,
the Engram node glyph, system fonts, and the default shadcn token set. That is
correct for bare `/login` and for suite clients. It is visually wrong for
Tradepost users who are signing into `ccgtradepost.com`: the rest of that
product uses a dark parchment/gold MTG identity, serif display type, and a
`CCG TRADEPOST` wordmark.

Some client branding already exists in the native auth client registry. Login,
register, and set-password pages resolve `PublicAuthClientConfig` server-side
from the incoming client context and pass `brandName` / `brandTagline` to the
shared `AuthShell`. The registry also has `brandLogoUrl` and
`brandPrimaryColor` columns, but those fields are insufficient for a full-page
theme and would require DB-seeded design state. Email templates already avoid
that shape: `EmailTemplateTheme = "cortex" | "tradepost"` is a static
code-keyed registry, not an operator-configured theme designer.

The goal is a presentation-only mechanism that lets one client get a distinct
auth look without changing the auth flow, without touching Tradepost, and
without altering the default Engram experience for any other client.

## Decisions

### D1. Auth brand theme is a static code-keyed registry

Add a small code registry:

```ts
type BrandTheme = "engram" | "tradepost";

brandThemeForClient(clientId: string | null): BrandTheme;
```

For now, `brandThemeForClient("tradepost-web")` returns `"tradepost"` and every
other value, including `null`, returns `"engram"`.

This mirrors the existing email-template theme precedent. We will not use
`brandLogoUrl` or `brandPrimaryColor` for this work, and we will not add a
migration. A single color cannot describe the Tradepost auth treatment, and
database-driven theme state would widen the blast radius for no current need.

### D2. The resolved theme is expressed as `data-brand-theme` on `AuthShell`

`AuthShell` accepts a `brandTheme` prop defaulting to `"engram"` and writes it
as a `data-brand-theme` attribute on the shell root. Login, register, and
set-password pass the value resolved from their existing
`PublicAuthClientConfig.clientId`.

The default Engram path is the invariant: bare `/login` and non-Tradepost
clients must keep the existing markup and visual treatment. Tradepost styling is
implemented only through selectors scoped under
`[data-brand-theme="tradepost"]`.

### D3. Theme CSS overrides shell styles and component tokens, scoped to auth

The Tradepost theme defines a single CSS block scoped to
`[data-brand-theme="tradepost"]`. It may override:

- auth shell background and wash;
- auth-specific mark, wordmark, headline, subtitle, trust caption, and card
  intro styles;
- shadcn CSS tokens consumed by cards, inputs, checkboxes, provider buttons, and
  primary buttons (`--card`, `--border`, `--primary`, `--primary-foreground`,
  `--ring`, `--muted-foreground`, and related tokens);
- auth-scoped selection colors.

Existing Engram selectors stay unchanged. The scoped token override makes the
forms read as Tradepost without forking the login/register/set-password form
markup or behavior.

### D4. Tradepost supports both appearance modes

The existing appearance preference remains authoritative: Engram sets a `.dark`
class on `<html>` using the current no-flash script and preference storage. The
brand theme composes with that class.

Tradepost defines both:

- a dark default aesthetic using Tradepost's dark parchment, gold accent, and
  radial gold glows; and
- a light parchment variant for users who select light mode.

The brand theme must not replace or bypass the appearance toggle.

### D5. Tradepost fonts load only for auth pages

`src/app/(auth)/layout.tsx` loads Fraunces, Archivo, and Martian Mono with
`next/font/google` and exposes them as CSS variables on an auth-only wrapper.

The fonts are available to the scoped Tradepost auth CSS, but the rest of Engram
continues to use the existing system stacks. This keeps the font cost limited to
the auth flow.

### D6. Tradepost wordmark is markup, not an image

For the Tradepost theme, `AuthShell` replaces the Engram node glyph with markup
matching Tradepost's app shell: a 12px gold square rotated 45 degrees with a 2px
radius, followed by the tracked bold text `CCG TRADEPOST`.

The "Secured by Engram" trust line stays present. Under the Tradepost theme it
is restyled as a quiet tracked mono caption rather than removed.

## Non-goals

- DB-driven or operator-configurable auth themes.
- Admin UI for themes.
- Logo uploads or asset management.
- Reworking email templates or the `EmailTemplateTheme` registry.
- Auth-flow changes: PKCE, redirects, magic links, providers, admission, and
  waitlist behavior are unchanged.
- Tradepost repository changes.

## Consequences

### Positive

- Tradepost gets a first-party-feeling auth entry point while continuing to use
  Engram's shared login host and flow.
- The mechanism is reusable: a future client adds one registry entry and one
  scoped CSS block.
- Default Engram remains protected because the theme is opt-in by client id and
  scoped by `data-brand-theme`.
- Auth forms inherit the branded treatment through CSS tokens instead of copied
  form components.

### Negative / trade-offs

- Themes are deploy-time code, not operator data. Adding or changing a client
  theme requires a PR and deploy.
- Each rich client theme adds CSS surface area that must be regression-tested in
  both light and dark modes.
- The `brandLogoUrl` and `brandPrimaryColor` columns remain unused for this
  class of theme, which may be surprising until those fields are removed or
  repurposed by a later ADR.

### Risks

- **Default-look drift.** A selector that is not scoped to
  `[data-brand-theme="tradepost"]` could alter bare `/login`. Mitigation:
  avoid edits to existing Engram selectors and verify bare `/login` screenshots.
- **Appearance-mode mismatch.** A theme that only handles dark mode would look
  broken for light-mode users. Mitigation: every theme CSS block must define
  both default/light and `.dark` variants.
- **Registry drift.** Client ids are code literals. Mitigation: keep the mapping
  tiny, test it where a test runner exists, and co-locate future additions in
  the registry.

## Future client process

To add another auth brand theme:

1. Add the theme literal to `BrandTheme`.
2. Add a `brandThemeForClient(clientId)` mapping for the client id.
3. Pass that resolved theme through the existing auth pages to `AuthShell`.
4. Add one `[data-brand-theme="<theme>"]` CSS block, including light and dark
   variants and scoped token overrides.
5. Capture themed and bare-Engram auth screenshots before merging.

No database migration, admin setting, or client-app repository change is part of
the standard path.

## Implementation notes

- New helper: `src/lib/auth-brand-theme.ts`.
- Auth shell entry point: `src/components/auth/auth-shell.tsx`.
- Auth-only font scope: `src/app/(auth)/layout.tsx`.
- The three server pages that resolve client config (`login`, `register`, and
  `set-password`) pass the resolved theme.
- Theme CSS lives in `src/app/globals.css` under a clearly labeled Tradepost auth
  section.

## Links

- ADR-018: Tradepost native client — `docs/adr/ADR-018-tradepost-native-client.md`
- ADR-027: Consumer-client admission and self-serve signup —
  `docs/adr/ADR-027-consumer-client-admission-and-self-serve-signup.md`
- Tradepost app shell wordmark source —
  `../../tradepost/src/components/app-shell.tsx`
