# Releasing documentation for a new pz version

This guide is for maintainers of this site. It says what to do with the documentation when pz
ships a release, and why the order of steps matters. Readers of the site do not need it.

## How versions work here

- The root pages (`/reference/cli/` and so on) describe the **latest released minor**. In the
  version dropdown they are labelled "Latest".
- Each earlier minor is archived under `src/content/docs/vX.Y/` and served at `/vX.Y/`. The
  archives are listed in `versions.json`; that file is the only switch the site reads.
- One archive per minor, never per patch. Patch releases edit the root pages in place.
- The landing page and the book series are not versioned.
- The site deploys from `main` on every push (`.github/workflows/deploy.yml`). Two checks run
  before the build: `scripts/check-versions.sh` fails if `versions.json` and the committed
  archives disagree, and `scripts/check-mdx-safe.mjs` fails if any versioned page would not
  parse as MDX (the freeze copies pages through remark-mdx).

## Patch release (v0.4.1, v0.4.2, ...)

Root already describes v0.4, so there is nothing to freeze.

1. Branch from `main`, edit the root pages, open a PR, merge.
2. If a page you touched came from the pz repository (`reference/events.md`,
   `reference/authoring-for-agents.md`), edit it there and run `scripts/sync-from-pz.sh`
   instead of editing the copy.

## New minor (v0.5)

The root pages must keep describing v0.4 until v0.5 ships. So the new docs are written on a
branch, v0.4 is frozen on release day, and only then do the new docs merge.

### 1. While v0.5 is in development

```bash
git checkout -b docs/v0.5 main
```

Edit the root pages on this branch as if v0.5 were current. Preview with
`astro dev --background`. Keep the branch rebased on `main` so patch-release fixes are not
lost. Do not merge it before release day.

### 2. On release day: freeze v0.4 on `main`

Start from a clean checkout of `main`.

```bash
git checkout main && git pull
scripts/freeze-version.sh v0.4
git add -A
git commit -m "docs: freeze v0.4"
git push
```

The script:

- refuses to run on a dirty tree, with a bad version name, or for a version that already
  exists;
- adds `v0.4` to `versions.json` and runs a build, during which the plugin copies every
  versioned page into `src/content/docs/v0.4/`, rewrites their links to `/v0.4/...`, writes the
  sidebar snapshot to `src/content/versions/v0.4.json`, and copies the diagrams those pages use
  into `public/diagrams/v0.4/` (and `public/diagrams/concepts/v0.4/`);
- runs `scripts/check-versions.sh` and prints the list of files to commit;
- on any failure restores `versions.json` and removes everything the build created, so the tree
  is left as it was.

After the push deploys, the dropdown shows "Latest" and "v0.4" with identical content. That is
expected; step 3 changes Latest.

### 3. Merge the v0.5 docs

Open the PR from `docs/v0.5` and merge it. Conflicts with the freeze commit are unlikely: the
freeze only adds files and one entry in `versions.json`. Root now describes v0.5, and `/v0.4/`
stays as it was.

### 4. Afterwards

- Typo fixes to the archived version go directly into `src/content/docs/v0.4/`. Nothing
  re-syncs archives from root.
- `astro dev` runs the same snapshot hook as the build, so restart it after a freeze.
- Never let CI create a snapshot. A snapshot made during a deploy is whatever `main` holds at
  that moment, labelled as the old version. `scripts/check-versions.sh` blocks the build in
  that case.

## Order matters

Freeze first, merge second. If the v0.5 docs merge before the freeze, the freeze snapshots
v0.5 content under the v0.4 label, and no check can tell the difference.

## Writing pages that survive a freeze

The freeze parses every versioned page as MDX, which is stricter than Markdown:

- Self-close void tags: `<img ... />`, `<br />`, `<hr />`.
- Put bare placeholders in code spans: `` `<name>` ``, not `<name>`.
- Leave `{` and `}` inside code blocks or code spans.

`node scripts/check-mdx-safe.mjs` reports every page that would fail, and CI runs it on every
deploy.

## Rolling back

- A freeze that has not been pushed: `git reset --hard origin/main`.
- A freeze that has been pushed but is wrong: revert the freeze commit. Do not delete the
  archive directory by hand without also removing the `versions.json` entry, or the guard
  fails the build.
