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
