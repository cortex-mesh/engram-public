#!/usr/bin/env bash
# ADR-032 — prod deploy gate: refuse to ship code ahead of the prod schema.
#
# The prod RDS is private, so the deploy runner cannot query it directly. The
# running app exposes its applied migrations at GET /api/health/migrations
# (`applied`: the authoritative set of applied names). We diff THIS checkout's
# migrations against that set: any checkout migration not applied to prod blocks
# the deploy, pointing to the human-gated bastion runbook — turning silent drift
# (the 2026-07-22 incident) into a red, actionable deploy.
#
# Fail-open/closed is keyed off the HTTP status so an ambiguous-but-reachable
# endpoint cannot silently wave a drifted deploy through:
#   - HTTP 200 + valid `applied` array (incl. empty) → diff; block on drift.
#   - HTTP 200 but no/invalid `applied`             → BLOCK (reachable but wrong).
#   - HTTP 5xx (e.g. wiped DB → no _prisma_migrations table → 503; DB down)
#                                                    → BLOCK (can't confirm).
#   - HTTP 404 (prod predates this endpoint / first deploy) → skip (bootstrap).
#   - unreachable (DNS/timeout/network)            → skip (transient).
# Redirects are followed (-L) so an infra redirect doesn't masquerade as junk.
# Escape hatch for a genuine endpoint-bug deadlock: MIGRATION_GATE_OVERRIDE=1.
set -euo pipefail

ENDPOINT="${MIGRATION_STATUS_URL:-https://auth.ccgtradepost.com/api/health/migrations}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-prisma/migrations}"
RUNBOOK="docs/runbooks/prod-db-migration-verify-apply.md"

if [[ "${MIGRATION_GATE_OVERRIDE:-}" == "1" ]]; then
  echo "::warning::migration-gate: OVERRIDDEN via MIGRATION_GATE_OVERRIDE=1 — skipping the prod schema check. Ensure prod migrations were verified manually ($RUNBOOK)."
  exit 0
fi

echo "migration-gate: checking prod schema currency via $ENDPOINT"
# Body + trailing HTTP status line; follow redirects. Distinguish a curl NETWORK
# failure (DNS/timeout/connection refused — transient → skip) from an HTTP
# response (curl exit 0, even for 5xx) via curl's exit code — `-w` emits "000"
# on connection failure, so an empty/000 check alone is not reliable.
if ! RAW="$(curl -sS -L --max-time 20 -w $'\n%{http_code}' "$ENDPOINT" 2>/dev/null)"; then
  echo "::warning::migration-gate: could not reach $ENDPOINT (DNS/timeout/network) — skipping. Verify prod migrations manually ($RUNBOOK)."
  exit 0
fi
HTTP_CODE="${RAW##*$'\n'}"
BODY="${RAW%$'\n'*}"
echo "migration-gate: endpoint responded HTTP $HTTP_CODE"

case "$HTTP_CODE" in
  200) : ;; # parse below
  404)
    echo "::warning::migration-gate: endpoint 404 — prod predates this endpoint (first ADR-032 deploy) — skipping. ($RUNBOOK)"
    exit 0
    ;;
  *)
    echo "::error::migration-gate: endpoint returned HTTP $HTTP_CODE — cannot confirm prod schema currency, refusing to deploy. A 5xx can mean the prod DB is unreachable or has no migrations applied (maximal drift). Investigate and/or apply migrations via $RUNBOOK. (Override with MIGRATION_GATE_OVERRIDE=1 only after manual verification.)"
    exit 1
    ;;
esac

# HTTP 200 — require a valid `applied` array. Anything else = reachable-but-wrong
# → BLOCK (never fail open on a 200).
APPLIED="$(printf '%s' "$BODY" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(2)
a = d.get("applied") if isinstance(d, dict) else None
if not isinstance(a, list) or not all(isinstance(x, str) for x in a):
    sys.exit(2)
print("\n".join(a))
')" && rc=0 || rc=$?
if [[ "${rc:-0}" -ne 0 ]]; then
  echo "::error::migration-gate: HTTP 200 but no valid \`applied\` array — refusing to deploy (endpoint may be misbehaving). Response starts: $(printf '%.120s' "$BODY")"
  exit 1
fi

# Authoritative applied set (may be empty → every checkout migration is pending).
# Portable membership via `grep -qxF` (no bash-4 associative arrays needed).
APPLIED_COUNT="$(grep -c . <<<"$APPLIED" || true)"
echo "migration-gate: prod has ${APPLIED_COUNT:-0} migration(s) applied."

UNAPPLIED=()
for dir in "$MIGRATIONS_DIR"/*/; do
  [[ -d "$dir" ]] || continue
  name="$(basename "$dir")"
  [[ "$name" =~ ^[0-9] ]] || continue
  grep -qxF "$name" <<<"$APPLIED" || UNAPPLIED+=("$name")
done

if [[ ${#UNAPPLIED[@]} -gt 0 ]]; then
  echo "::error::migration-gate: this build contains migrations NOT applied to prod:"
  printf '    %s\n' "${UNAPPLIED[@]}"
  echo "::error::Apply them to prod FIRST (human-gated bastion — $RUNBOOK), then re-run the deploy. (ADR-032)"
  exit 1
fi

echo "migration-gate: prod schema is current with this build — OK to deploy."
