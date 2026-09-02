#!/usr/bin/env bash
# Refuses to build when versions.json and the committed snapshots disagree.
#
# A listed version without a snapshot is the dangerous case: starlight-versions would create
# the snapshot during the CI build from whatever main holds at that moment and label it as the
# old version. A snapshot directory that is not listed is the reverse: its pages would render
# as unversioned current pages.
#
# Usage: scripts/check-versions.sh [site-root]   (default: the repository root)
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
DOCS="$ROOT/src/content/docs"
status=0

listed=$(node -e 'const f=require("node:fs");process.stdout.write(JSON.parse(f.readFileSync(process.argv[1],"utf8")).versions.map(v=>v.slug).join("\n"))' "$ROOT/versions.json")

for slug in $listed; do
  if [[ ! -d "$DOCS/$slug" ]]; then
    echo "check-versions: '$slug' is listed in versions.json but src/content/docs/$slug/ is missing (run scripts/freeze-version.sh and commit the snapshot)" >&2
    status=1
  fi
  if [[ ! -f "$ROOT/src/content/versions/$slug.json" ]]; then
    echo "check-versions: '$slug' is listed in versions.json but src/content/versions/$slug.json is missing" >&2
    status=1
  fi
done

for dir in "$DOCS"/v[0-9]*.[0-9]*; do
  [[ -d "$dir" ]] || continue
  slug="$(basename "$dir")"
  if ! grep -qx -- "$slug" <<<"$listed"; then
    echo "check-versions: src/content/docs/$slug/ exists but '$slug' is not listed in versions.json" >&2
    status=1
  fi
done

[[ $status -eq 0 ]] && echo "check-versions: ok ($(wc -w <<<"$listed") archived version(s))"
exit $status
