# pipelinez-site

Presentation site for [PipelineZ (`pz`)](https://github.com/coccor/pz) — a lightweight, developer-first batch data pipeline engine for SQL-based ETL/ELT, powered by DuckDB, that can run anywhere without requiring a data platform.

Built with [Astro](https://astro.build) + [Starlight](https://starlight.astro.build)
using the [Catppuccin theme](https://github.com/catppuccin/starlight). Hosts
the *Data Pipelines* article series under `/articles/`.

```bash
npm install
npm run dev      # local dev server
npm run build    # static build to dist/
```

Deploys to GitHub Pages on push to `main` (`.github/workflows/deploy.yml`).

The articles in `src/content/docs/articles/` originate from `docs/book/` in
the pz repository (PR #55).
