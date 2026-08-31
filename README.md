# pipelinez-site

Documentation and presentation site for [PipelineZ (`pz`)](https://github.com/PipelineZ/pz) — a
lightweight, developer-first batch data pipeline engine for SQL-based ETL/ELT, powered by
DuckDB, that can run anywhere without requiring a data platform.

Built with [Astro](https://astro.build) + [Starlight](https://starlight.astro.build), on a
custom PipelineZ theme (`src/styles/theme.css`). Hosts the full docs — concepts, how-to guides,
CLI/project reference, and diagrams under `src/content/docs/` — plus the *Data Pipelines*
article series under `/book/` (moved from `/articles/`; old links redirect, see
`astro.config.mjs`).

```bash
npm install
npm run dev      # local dev server
npm run build    # static build to dist/
```

Deploys to GitHub Pages on push to `main` (`.github/workflows/deploy.yml`).

The book articles in `src/content/docs/book/` originate from `docs/book/` in the pz repository
(PR #55). Everything else — concepts, how-to, reference, diagrams — is maintained here directly;
see the pz repo's `CLAUDE.md` for which two files stay authoritative there instead
(`docs/events.md`, `docs/reference/authoring-for-agents.md`).
