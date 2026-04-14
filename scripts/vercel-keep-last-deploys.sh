#!/usr/bin/env bash
# Keep only the N newest Vercel deployments for the linked project; remove the rest.
set -e
cd "$(dirname "$0")/.."
KEEP="${1:-3}"
ALL_FILE="$(mktemp)"
trap 'rm -f "$ALL_FILE"' EXIT
NEXT=""
ITER=0
while [ "$ITER" -lt 500 ]; do
  ITER=$((ITER + 1))
  if [ -z "$NEXT" ]; then
    OUT=$(vercel ls -y 2>&1)
  else
    OUT=$(vercel ls -y --next "$NEXT" 2>&1)
  fi
  # Obecny team (super-team-575a597e) i stary slug (super-team1) — jeden projekt ptg.
  echo "$OUT" | grep -oE 'https://ptg-[a-z0-9]+-super-team[a-z0-9-]*\.vercel\.app' >> "$ALL_FILE" || true
  if ! echo "$OUT" | grep -q "To display the next page"; then
    break
  fi
  NEW_NEXT=$(echo "$OUT" | sed -n 's/.*--next \([0-9][0-9]*\).*/\1/p' | tail -1)
  [ -z "$NEW_NEXT" ] && break
  [ "$NEW_NEXT" = "$NEXT" ] && break
  NEXT=$NEW_NEXT
done
UNIQ="$(mktemp)"
trap 'rm -f "$ALL_FILE" "$UNIQ"' EXIT
awk '!seen[$0]++' "$ALL_FILE" > "$UNIQ"
TOTAL=$(wc -l < "$UNIQ" | tr -d ' ')
echo "Found $TOTAL unique deployments (newest first)."
if [ "$TOTAL" -le "$KEEP" ]; then
  echo "Nothing to remove."
  exit 0
fi
RM_COUNT=$((TOTAL - KEEP))
echo "Removing $RM_COUNT deployments (keeping newest $KEEP) with --safe (skips aliased)."
mapfile -t ORDERED < "$UNIQ"
i=$KEEP
while [ "$i" -lt "$TOTAL" ]; do
  batch=()
  b=0
  while [ "$b" -lt 10 ] && [ "$i" -lt "$TOTAL" ]; do
    batch+=("${ORDERED[i]}")
    i=$((i + 1))
    b=$((b + 1))
  done
  if ! vercel remove "${batch[@]}" -y -s; then
    echo "Remove failed (rate limit?). Wait ~10 minutes and run again." >&2
    exit 1
  fi
  sleep 3
done
echo "Done."
