# Tradepost Auth Theme Checkpoint

**Date:** 2026-07-20  
**Goal prompt:** meta repo
`docs/plans/2026-07-20-engram-tradepost-auth-theme-goal-prompt.md`

## Shipped

- `docs/adr/ADR-028-per-client-auth-brand-theming.md` documents the static
  client-id keyed auth theme registry, `data-brand-theme` on `AuthShell`, and
  scoped CSS-token override model.
- `src/lib/auth-brand-theme.ts` maps `tradepost-web` to the Tradepost auth
  theme and keeps bare/unknown clients on `engram`.
- Login, register, and set-password pass the resolved theme into `AuthShell`.
- `AuthShell` keeps the existing Engram node-mark path for the default theme and
  renders the CCG Tradepost markup wordmark only for `brandTheme="tradepost"`.
- `src/app/(auth)/layout.tsx` loads Fraunces, Archivo, and Martian Mono as
  auth-scoped CSS variables.
- `src/app/globals.css` appends a Tradepost-only `[data-brand-theme="tradepost"]`
  block with light/dark shell backgrounds, shadcn token overrides, form styling,
  wordmark styles, mono labels/buttons, and gold selection colors.
- Follow-up polish allows the taller Tradepost register/waitlist form to scroll
  and tones down the dark-mode gold wash so the flat `#161210` base dominates.

## PRs

- ADR: https://github.com/cortex-mesh/engram/pull/178
- Code: https://github.com/cortex-mesh/engram/pull/179
- Polish: https://github.com/cortex-mesh/engram/pull/180

## Verification

Local gates:

- PR #178: `npm run lint`, `npm run prisma:generate`, `npm run build`
- PR #179: `npm test`, `npm run lint`, `npm run build`
- PR #180: `npm test -- tests/components/auth-shell.test.ts tests/lib/auth-brand-theme.test.ts`,
  `npm run lint`, `npm run build`

CI/deploy:

- ADR deploy run `29758877777`: green for Deploy AWS dev and Deploy on-prem-host/on-prem
  after controller cleared external dev-host Docker build cache/disk pressure.
- Code deploy run `29761339514`: green for Deploy AWS dev and Deploy on-prem-host/on-prem.
- Polish deploy run `29762194781`: green for Deploy AWS dev and Deploy on-prem-host/on-prem.

Live screenshots were captured with headless Chrome via CDP and read locally from
`/tmp/engram-auth-theme-live-final/`:

- `tradepost-login-dark.png` — `data-brand-theme="tradepost"`, Tradepost dark
  parchment/gold theme, CCG Tradepost wordmark, Fraunces headline, styled inputs,
  gold primary submit, provider button, and mono `Secured by Engram`.
- `tradepost-login-light.png` — parchment light variant with the same Tradepost
  wordmark, serif/mono type treatment, and fully styled form.
- `engram-login-light.png` — bare `/login` remains default Engram/CORTEX with
  the node glyph, slate/light shell, and `data-brand-theme="engram"`.
- `tradepost-register-dark-tall.png` — register/waitlist page is Tradepost
  themed; the full enrichment form and footer are visible with no clipping.
- `tradepost-e2e-after-login.png` — full browser round trip from
  `https://tradepost.dev.ctxhost.com/auth/signin` through themed Engram login
  lands at `https://tradepost.dev.ctxhost.com/` with a signed-in Tradepost home
  showing `Morning, Demo.`

E2E login used only the canonical demo-owner credentials from
`~/.secrets/demo-tenant-test.env`; no `cortex` org or ad-hoc account was used.

## Surprises

- The local `claude --model opus ...` subprocess wedged silently for ADR
  authoring and for each required pre-PR review. Each occurrence was documented
  on the relevant PR; the work proceeded on self-review plus green local/CI
  gates per the goal prompt.
- The first ADR aws-dev deploy failure was not caused by the docs change. The
  controller found the dev app host disk at 100% from Docker build cache, pruned
  170GB, and reran the deploy green.
- Screenshot review caught two presentation issues after the main theme PR:
  the register/waitlist form needed vertical scrolling, and the first dark-mode
  gold wash was hotter than Tradepost's app shell. PR #180 fixed both.
- GitHub CLI on this machine does not expose a binary attachment command for PR
  comments, so the PR comments contain the screenshot inventory and local paths
  rather than uploaded PNG attachments.

## Status

Phase 0, Phase 1, and Phase 2 are complete for aws-dev. Promotion to
`login.ctxhost.com` / aws-prod remains human-only and was not attempted.
