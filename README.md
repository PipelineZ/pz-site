# pipelinez-site

Documentation and presentation site for [PipelineZ (`pz`)](https://github.com/PipelineZ/pz) — a
lightweight, developer-first batch data pipeline engine for SQL-based ETL/ELT, powered by
DuckDB, that can run anywhere without requiring a data platform.

Built with [Astro](https://astro.build) + [Starlight](https://starlight.astro.build), on a
custom PipelineZ theme (`src/styles/theme.css`). Hosts the full docs — concepts, how-to guides,
CLI/project reference, and diagrams under `src/content/docs/` — plus the *Data Pipelines*
article series under `/book/`.

```bash
npm install
npm run dev      # local dev server
npm run build    # static build to dist/
```

Deploys to GitHub Pages on push to `main` (`.github/workflows/deploy.yml`).

## Documentation versions

Step-by-step release procedure: [docs/releasing-documentation.md](docs/releasing-documentation.md).

Root pages describe the latest released pz minor. Older minors are archived under
`src/content/docs/vX.Y/` and served at `/vX.Y/`, with a version dropdown in the header.
`versions.json` lists the archives; `scripts/check-versions.sh` fails the deploy if that list
and the committed snapshots disagree.

### Day to day

- Edit root pages as usual. Patch releases of the current minor edit root in place.
- Docs for an unreleased minor go on a branch (`docs/vX.Z`), never on `main`.
- To fix a typo in an archive, edit the files under `src/content/docs/vX.Y/` directly.
- `astro dev` runs the same snapshot hook as the build, so after adding a version restart it.
- Every versioned page must parse as MDX, because the freeze copies pages through remark-mdx:
  self-close void tags (`<img ... />`) and put bare `<placeholder>` text in code spans.
  `node scripts/check-mdx-safe.mjs` checks this; CI runs it on every deploy.

### Releasing a new minor

1. On `main` with a clean tree, freeze the outgoing minor:
   `scripts/freeze-version.sh v0.4`
   The build copies the docs into `src/content/docs/v0.4/`, rewrites links, and writes
   `src/content/versions/v0.4.json`. It also copies the diagrams the archived pages use into
   `public/diagrams/v0.4/` (and `public/diagrams/concepts/v0.4/`).
2. Commit everything `git status` lists (the script prints the command), as `docs: freeze v0.4`.
3. Merge the branch holding the new minor's docs. Root now describes the new release.

Never let CI create a snapshot: a snapshot made during a deploy is whatever `main` holds at
that moment, labelled as the old version.
