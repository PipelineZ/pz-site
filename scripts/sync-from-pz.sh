#!/usr/bin/env bash
# Copies the two pages whose source of truth lives in the pz repository into this site,
# prepending a "generated" banner so nobody edits the copy by hand.
#
# Usage: scripts/sync-from-pz.sh [path-to-pz-checkout]   (default: ../pz)
set -euo pipefail

PZ="${1:-$(dirname "$0")/../../pz}"
SITE="$(cd "$(dirname "$0")/.." && pwd)"
DOCS="$SITE/src/content/docs"

sync() {
  local src="$PZ/$1" dst="$DOCS/$2" title="$3" description="$4" order="$5"
  [[ -f "$src" ]] || { echo "missing $src" >&2; exit 1; }
  {
    printf -- '---\ntitle: "%s"\ndescription: "%s"\nsidebar:\n  order: %s\n---\n\n' "$title" "$description" "$order"
    printf ':::note\nThis page is generated from `%s` in the pz repository. Edit it there, then run `scripts/sync-from-pz.sh`.\n:::\n\n' "$1"
    # Drop the upstream H1 (Starlight renders the frontmatter title) and any leading blank lines.
    awk 'BEGIN{skip=1} skip && /^# /{next} skip && /^[[:space:]]*$/{next} {skip=0; print}' "$src"
  } > "$dst"
  echo "synced $1 -> ${dst#$SITE/}"
}

sync docs/events.md reference/events.md \
  "Run events" \
  "Every event pz emits on the NDJSON stream during a run, field by field, with the stability guarantees for each." \
  8

sync docs/reference/authoring-for-agents.md reference/authoring-for-agents.md \
  "Authoring for agents" \
  "The compact authoring contract an AI agent needs to write a valid pz project: files, keys, template calls, and the rules pz enforces." \
  10
