#!/usr/bin/env bash
# migration-guard (cortex ADR-128 §D2/D4).
#
# A migration on a shared multi-tenant DB is the least-reversible thing the
# fleet can do (see the 2026-06-26 Thoughts data-loss incident). But requiring
# a human to approve *every* migration is pure friction for the common case:
# additive, non-destructive changes (ADD COLUMN, CREATE TABLE, CREATE INDEX)
# cannot lose existing data and are trivially recoverable.
#
# So the gate is narrowed (Roland, 2026-07-15): ADDITIVE-only migrations pass
# automatically; only DESTRUCTIVE migrations — the ones that can drop or mutate
# existing data — require a human APPROVED review. Prevention stays exactly
# where a mistake is unrecoverable, and nobody is bothered by routine columns.
#
# Wire this as a required CI status check via branch protection (ADR-128 §D2).
set -euo pipefail

BASE="${BASE_BRANCH:-origin/main}"

# Detect changed migration SQL (three-dot PR diff vs BASE).
CHANGED=$(git diff --name-only "${BASE}...HEAD" \
  | grep -E '^prisma/(migrations|manual-migrations)/.*\.sql$' \
  || true)

if [[ -z "$CHANGED" ]]; then
  echo "migration-guard: no migration SQL changed — OK"
  exit 0
fi

echo "migration-guard: migration files changed:"
echo "$CHANGED"
echo ""

# Look at ADDED lines only (what this PR introduces), stripped of SQL comments,
# uppercased. Scanning only added lines means an unrelated pre-existing
# statement in a touched file can't trip the gate.
ADDED=$(git diff "${BASE}...HEAD" -- $CHANGED \
  | grep -E '^\+' | grep -vE '^\+\+\+' \
  | sed -E 's/^\+//' \
  | sed -E 's/--.*$//' \
  | tr '[:lower:]' '[:upper:]')

# Destructive patterns: operations that can DROP or irreversibly LOSE existing
# data. These require a human. Deliberately conservative on the lossy ones.
#   DROP TABLE/COLUMN/CONSTRAINT/SCHEMA/TYPE/INDEX/VIEW/SEQUENCE
#   DELETE FROM / TRUNCATE        (the Thoughts data-loss incident was a DELETE)
#   ALTER TABLE … DROP …          (column/constraint removal)
#   ALTER COLUMN … TYPE …         (type change can silently truncate/lose data)
#   RENAME                        (breaks consumers / can lose data)
#
# NOT gated (auto-flow), because they are the standard SAFE additive pattern:
#   ADD COLUMN / CREATE TABLE / CREATE INDEX / new type or enum value
#   UPDATE and SET NOT NULL       — these are how an additive migration backfills
#                                   a newly-added column (e.g. 0019). A genuinely
#                                   lossy data UPDATE is rare in Prisma migrations
#                                   and is still caught by the mandatory Opus code
#                                   review + point-in-time backups; it is not
#                                   worth gating every routine backfill for.
DESTRUCTIVE_REGEX='(DROP[[:space:]]+(TABLE|COLUMN|CONSTRAINT|SCHEMA|TYPE|INDEX|VIEW|SEQUENCE))|(DELETE[[:space:]]+FROM)|(TRUNCATE)|(ALTER[[:space:]]+TABLE[[:space:]].*[[:space:]]DROP[[:space:]])|(ALTER[[:space:]]+COLUMN[[:space:]].*[[:space:]]TYPE[[:space:]])|(RENAME)'

DESTRUCTIVE=$(printf '%s\n' "$ADDED" | grep -nE "$DESTRUCTIVE_REGEX" || true)

if [[ -z "$DESTRUCTIVE" ]]; then
  echo "migration-guard: additive-only migration (no destructive SQL detected) — auto-approved."
  echo "  Additive changes (ADD COLUMN / CREATE TABLE / CREATE INDEX / new type or enum)"
  echo "  cannot lose existing data, so no human approval is required (ADR-128, 2026-07-15)."
  exit 0
fi

echo "migration-guard: DESTRUCTIVE SQL detected — human approval required:"
printf '%s\n' "$DESTRUCTIVE" | sed 's/^/    /'
echo ""

# Destructive migration → require at least one human APPROVED review.
APPROVALS=$(gh pr view "${PR_NUMBER}" --repo "${GITHUB_REPOSITORY}" \
  --json reviews \
  --jq '[.reviews[] | select(.state == "APPROVED") | select(.author.login | endswith("[bot]") | not)] | length' \
  2>/dev/null | tr -d '[:space:]' || echo "0")
APPROVALS="${APPROVALS:-0}"

if [[ "$APPROVALS" -ge 1 ]]; then
  echo "migration-guard: ${APPROVALS} human approval(s) on a destructive migration — OK"
  exit 0
fi

echo "ERROR: this migration drops or mutates existing data but has no human approval." >&2
echo "A destructive migration on a shared multi-tenant DB requires human review (ADR-128 §D4)." >&2
echo "Request a review from @rolme before merging. (Additive migrations auto-pass; this one is not.)" >&2
exit 1
