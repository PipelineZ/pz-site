# pipelinez-site

Presentation site for [PipelineZ (`pz`)](https://github.com/coccor/pz) — a
dbt-inspired batch ETL CLI for .NET powered by DuckDB.

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
