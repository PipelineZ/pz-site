#!/usr/bin/env bash
# Fixture tests for check-versions.sh. Builds throwaway site roots in a temp dir and asserts
# the guard's exit code for each case. Run: scripts/test-check-versions.sh
set -euo pipefail

CHECK="$(cd "$(dirname "$0")" && pwd)/check-versions.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fixture() { # fixture <name> <versions-json> [snapshot-slug...]
  local root="$TMP/$1"
  mkdir -p "$root/src/content/docs" "$root/src/content/versions"
  printf '%s\n' "$2" > "$root/versions.json"
  shift 2
  for slug in "$@"; do
    mkdir -p "$root/src/content/docs/$slug"
    echo '{}' > "$root/src/content/versions/$slug.json"
  done
  echo "$root"
}

expect() { # expect <0|1> <root> <case>
  local want="$1" root="$2" name="$3" got=0
  "$CHECK" "$root" >/dev/null 2>&1 || got=$?
  if [[ "$got" == "$want" ]]; then echo "ok   $name"; else echo "FAIL $name (exit $got, want $want)"; exit 1; fi
}

expect 0 "$(fixture empty '{"versions":[]}')" "empty list, no snapshots"
expect 0 "$(fixture listed '{"versions":[{"slug":"v0.4","label":"v0.4"}]}' v0.4)" "listed version with snapshot"
expect 1 "$(fixture missing '{"versions":[{"slug":"v0.4","label":"v0.4"}]}')" "listed version without snapshot"
root="$(fixture nojson '{"versions":[{"slug":"v0.4","label":"v0.4"}]}' v0.4)"; rm "$root/src/content/versions/v0.4.json"
expect 1 "$root" "listed version without sidebar json"
expect 1 "$(fixture orphan '{"versions":[]}' v0.4)" "snapshot directory not listed"
echo "all passed"
