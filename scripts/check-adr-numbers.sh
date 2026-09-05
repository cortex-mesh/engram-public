#!/usr/bin/env bash
# ADR-number guard (cortex ADR-128).
#
# Usage:
#   bash scripts/check-adr-numbers.sh check      # CI: fail if added ADR has stale/dup number
#   bash scripts/check-adr-numbers.sh next-adr   # Print next-free ADR number
#
# Environment:
#   BASE_BRANCH  - git ref to compare against (default: origin/main)
#   ADR_DIR      - path to the ADR directory  (default: docs/adr)
#
# Exit codes (check mode):
#   0  nothing to check, or all added ADRs pass
#   1  at least one added ADR fails the strictly-monotonic / no-duplicate rule
set -euo pipefail

MODE="${1:-check}"
ADR_DIR="${ADR_DIR:-docs/adr}"
BASE="${BASE_BRANCH:-origin/main}"

# Extract ADR number from a filename (e.g. docs/adr/ADR-042-foo.md -> 042).
# Always exits 0 so callers inside pipelines don't die under set -e.
_adr_num() { echo "$1" | grep -oE 'ADR-[0-9]+' | head -1 | sed 's/ADR-//' || true; }

# List all ADR numbers present on BASE (one per line, sorted numerically).
_adr_numbers_on_base() {
  git ls-tree -r --name-only "$BASE" -- "${ADR_DIR}/" 2>/dev/null \
    | grep -E 'ADR-[0-9]+' \
    | while IFS= read -r f; do _adr_num "$f"; done \
    | grep -E '^[0-9]+$' \
    | sort -n \
    || true
}

if [[ "$MODE" == "next-adr" ]]; then
  MAX=$(_adr_numbers_on_base | tail -1)
  echo $((10#${MAX:-0} + 1))
  exit 0
fi

# --- check mode ---

# Find docs/adr files ADDED by this branch relative to BASE.
# Three-dot diff (BASE...HEAD) uses the merge base so it only shows what
# the branch adds, regardless of commits on main since the branch forked.
# Tab separator in awk handles filenames with spaces safely.
ADDED_FILES=$(git diff --name-status "${BASE}...HEAD" -- "${ADR_DIR}/" 2>/dev/null \
  | awk -F '\t' '$1 == "A" { print $2 }' \
  | grep -E 'ADR-[0-9]+' \
  || true)

if [[ -z "$ADDED_FILES" ]]; then
  echo "adr-check: no new ADR files added — OK"
  exit 0
fi

# Snapshot BASE numbers once — avoids two git ls-tree calls and any
# inconsistency if the ref moved between calls.
ALL_EXISTING=$(_adr_numbers_on_base)
MAX=$(echo "$ALL_EXISTING" | tail -1)
MAX="${MAX:-0}"

FAIL=0

# Check for intra-PR duplicates (two files with the same ADR number in one PR).
DUP_NUMS=$(echo "$ADDED_FILES" \
  | while IFS= read -r f; do _adr_num "$f"; done \
  | grep -E '^[0-9]+$' \
  | sort | uniq -d \
  || true)
if [[ -n "$DUP_NUMS" ]]; then
  while IFS= read -r dup; do
    echo "ERROR: ADR-${dup} appears more than once in this PR" >&2
    FAIL=1
  done <<< "$DUP_NUMS"
fi

# Check each added ADR against BASE numbers.
while IFS= read -r file; do
  N=$(_adr_num "$file")
  if [[ -z "$N" ]]; then
    echo "WARNING: could not extract ADR number from ${file}, skipping" >&2
    continue
  fi
  N_DEC=$((10#$N))
  MAX_DEC=$((10#$MAX))

  if echo "$ALL_EXISTING" | grep -qxF "$N"; then
    echo "ERROR: ADR-${N} already exists on ${BASE} — duplicate number (file: ${file})" >&2
    FAIL=1
  elif [[ "$N_DEC" -le "$MAX_DEC" ]]; then
    echo "ERROR: ADR-${N} ≤ max ADR on ${BASE} (${MAX}) — not strictly monotonic (file: ${file})" >&2
    FAIL=1
  else
    echo "OK: ADR-${N} is valid (max on ${BASE} = ${MAX})"
  fi
done <<< "$ADDED_FILES"

exit "$FAIL"
