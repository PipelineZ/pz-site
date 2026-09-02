#!/usr/bin/env bash
# Archives the current documentation as one minor version.
#
# Run on `main`, on release day, for the OUTGOING minor, before merging the next minor's docs:
#   scripts/freeze-version.sh v0.4
# Adds the version to versions.json and runs a build, during which starlight-versions copies
# every versioned page into src/content/docs/v0.4/, rewrites its links, and writes the sidebar
# snapshot to src/content/versions/v0.4.json, and copies the diagrams those pages use into
# public/diagrams/v0.4/. Commit everything the script lists.
# On failure after versions.json has been edited, the script restores versions.json and
# removes any partial snapshot so the working tree is left clean.
set -euo pipefail

SITE="$(cd "$(dirname "$0")/.." && pwd)"
slug="${1:-}"

if [[ ! "$slug" =~ ^v[0-9]+\.[0-9]+$ ]]; then
  echo "usage: scripts/freeze-version.sh vX.Y   (one archive per minor, e.g. v0.4)" >&2
  exit 2
fi
if [[ -n "$(git -C "$SITE" status --porcelain)" ]]; then
  echo "freeze-version: working tree is dirty; commit or stash first so the snapshot is reviewable on its own" >&2
  exit 1
fi
if [[ -d "$SITE/src/content/docs/$slug" ]]; then
  echo "freeze-version: src/content/docs/$slug/ already exists" >&2
  exit 1
fi

node - "$SITE/versions.json" "$slug" <<'EOF'
const fs = require('node:fs');
const [file, slug] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
if (data.versions.some((v) => v.slug === slug)) {
  console.error(`freeze-version: ${slug} is already listed in versions.json`);
  process.exit(1);
}
data.versions.unshift({ slug, label: slug });
fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
EOF

rollback() {
  # The tree was clean when we started, so every untracked path is build output.
  local failed=0
  git -C "$SITE" checkout -- versions.json || failed=1
  git -C "$SITE" clean -fd -- . >/dev/null || failed=1
  if [[ $failed -ne 0 ]]; then
    echo "freeze-version: rollback incomplete; run 'git status' and clean up by hand" >&2
  fi
}

if ! (cd "$SITE" && npx astro build); then
  rollback
  echo "freeze-version: build failed; versions.json restored, nothing to commit" >&2
  exit 1
fi

if [[ ! -d "$SITE/src/content/docs/$slug" || ! -f "$SITE/src/content/versions/$slug.json" ]]; then
  rollback
  echo "freeze-version: the build did not create the snapshot for $slug; versions.json restored" >&2
  exit 1
fi

if ! "$SITE/scripts/check-versions.sh"; then
  rollback
  echo "freeze-version: snapshot check failed; versions.json restored, nothing to commit" >&2
  exit 1
fi

cat <<MSG

Snapshot for $slug is ready. It consists of:
MSG
git -C "$SITE" status --porcelain
cat <<MSG

Review it, then commit everything above:

  git add -A
  git commit -m "docs: freeze $slug"
MSG
