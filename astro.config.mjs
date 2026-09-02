// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { readFileSync } from 'node:fs';
import starlightVersions from 'starlight-versions';

// Archived documentation versions, newest first. The freeze script appends to this file;
// see README.md "Releasing a new minor". Empty means the site has a single, current version.
const { versions } = JSON.parse(readFileSync(new URL('./versions.json', import.meta.url), 'utf8'));

// The series moved from /articles/ to /book/; these keep every published link alive.
const bookPages = [
	'',
	'01-what-is-a-data-pipeline',
	'02-modern-data-infrastructure',
	'03-common-pipeline-patterns',
	'04-data-ingestion-extracting-and-loading',
	'05-transforming-data',
	'06-orchestrating-pipelines',
	'07-data-validation-and-quality',
	'08-monitoring-and-observability',
	'09-best-practices',
	'10-meet-pz',
];

// Pages that moved or merged in the 2026-09 documentation revamp.
const movedPages = {
	'/concepts/architecture-overview': '/internals/architecture',
	'/concepts/data-plane': '/internals/data-plane',
	'/concepts/code-tour': '/internals/code-tour',
	'/concepts/contributing-internals': '/internals/contributing',
	'/concepts/project-structure': '/concepts/project-layout',
	'/concepts/execution-model': '/concepts/how-a-run-works',
	'/concepts/validation': '/concepts/validation-and-errors',
	'/events': '/reference/events',
	'/diagrams': '/internals/diagrams',
	'/diagrams/01-overview': '/internals/diagrams',
	'/diagrams/02-compile-dag': '/internals/diagrams',
	'/diagrams/03-data-plane': '/internals/diagrams',
	'/diagrams/04-run-lifecycle': '/internals/diagrams',
	'/diagrams/05-resilience-and-resume': '/internals/diagrams',
	'/how-to/gcs': '/connectors/gcs',
};

// https://astro.build/config
export default defineConfig({
	site: 'https://pipelinez.dev',
	redirects: {
		...Object.fromEntries(bookPages.map((page) => [`/articles/${page}`, `/book/${page}`])),
		...movedPages,
		...Object.fromEntries(versions.map((v) => [`/${v.slug}`, `/${v.slug}/docs`])),
	},
	integrations: [
		starlight({
			title: 'PipelineZ',
			description:
				'A lightweight, developer-first batch data pipeline engine for SQL-based ETL/ELT, powered by DuckDB, that can run anywhere without requiring a data platform.',
			// Code blocks read better dark — keep them that way on both themes
			// rather than following the site's own light/dark toggle.
			expressiveCode: { themes: ['github-dark'] },
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/PipelineZ/pz' },
			],
			plugins: [
				// The plugin refuses an empty version list, and a dropdown with only "Latest" says
				// nothing, so it is registered only once the first minor has been frozen.
				...(versions.length > 0
					? [
							starlightVersions({
								current: { label: 'Latest', redirect: 'same-page' },
								// Landing on the archive's root (redirected to /vX.Y/docs/ above) beats a 404
								// when the page being read did not exist in that version.
								versions: versions.map((v) => ({ ...v, redirect: 'root' })),
								// Not release-bound, so never copied: the landing page and the book series.
								exclude: ['index.mdx', 'book/**'],
							}),
						]
					: []),
			],
			sidebar: [
				{
					label: 'Start here',
					items: [
						{ label: 'Documentation', slug: 'docs' },
						{ label: 'Install', slug: 'install' },
						{ label: 'Quickstart', slug: 'quickstart' },
						{ label: 'Tutorial', slug: 'tutorial' },
					],
				},
				{
					label: 'Concepts',
					items: [
						'concepts/key-concepts',
						'concepts/project-layout',
						'concepts/connections-and-entities',
						'concepts/pipelines',
						'concepts/checks',
						'concepts/incremental-loads',
						'concepts/selecting-nodes',
						'concepts/how-a-run-works',
						'concepts/delivery-guarantees',
						'concepts/validation-and-errors',
						'concepts/state',
						'concepts/schema-contracts',
						'concepts/connectors',
					],
				},
				{
					label: 'How-to guides',
					items: [
						{ label: 'All guides', slug: 'guides' },
						{
							label: 'Ingest',
							items: [
								'how-to/extract-from-http-api',
								'how-to/capture-changes-with-cdc',
								'how-to/backfill-in-slices',
							],
						},
						{
							label: 'Reliability',
							items: [
								'how-to/run-checks-and-retry',
								'how-to/tune-retries',
								'how-to/throttle-a-source',
								'how-to/handle-schema-drift',
								'how-to/schema-drift',
								'how-to/debug-a-failed-run',
							],
						},
						{
							label: 'Production',
							items: [
								'how-to/secure-connection-config',
								'how-to/remote-state',
								'how-to/run-in-ci',
								'how-to/run-scheduled-on-windows',
								'how-to/observe-runs-with-azure-monitor',
								'how-to/inspect-and-validate',
							],
						},
						{ label: 'AI agents', items: ['how-to/use-with-an-ai-agent'] },
						{ label: 'Extend', items: ['how-to/author-a-connector'] },
					],
				},
				{
					label: 'Connectors',
					items: [
						{ label: 'All connectors', slug: 'connectors' },
						'connectors/localfiles',
						'connectors/postgres',
						'connectors/sqlserver',
						'connectors/mysql',
						'connectors/sqlite',
						'connectors/s3',
						'connectors/azureblob',
						'connectors/gcs',
						'connectors/sftp',
						'connectors/http',
					],
				},
				{
					label: 'Reference',
					items: [
						'reference/cli',
						'reference/project-yml',
						'reference/connections-yml',
						'reference/pipeline-config',
						'reference/template-functions',
						'reference/error-codes',
						'reference/environment-variables',
						'reference/events',
						'reference/mcp-contract',
						'reference/authoring-for-agents',
						{ label: 'Versioning', slug: 'versioning' },
					],
				},
				{
					label: 'Internals',
					collapsed: true,
					items: [
						'internals/architecture',
						'internals/data-plane',
						'internals/execution-internals',
						'internals/resume-internals',
						'internals/connector-architecture',
						'internals/code-tour',
						'internals/contributing',
						'internals/diagrams',
					],
				},
				{
					label: 'Data Pipelines: An Article Series',
					items: [{ autogenerate: { directory: 'book' } }],
				},
			],
			components: {
				Header: './src/components/Header.astro',
				PageFrame: './src/components/PageFrame.astro',
				Sidebar: './src/components/Sidebar.astro',
				SiteTitle: './src/components/SiteTitle.astro',
				SocialIcons: './src/components/SocialIcons.astro',
			},
			// Splits the sidebar: /book/* shows only the series, everywhere else only the docs.
			routeMiddleware: './src/starlightRouteData.ts',
			customCss: [
				// The default export only varies weight (opsz pinned to its default
				// instance); `standard.css` carries the full [opsz,wdth,wght] variable
				// font, which is what actually gives the display headings their
				// character at large sizes — Bricolage Grotesque's optical-size axis
				// is a big part of its look, and browsers apply it automatically via
				// `font-optical-sizing: auto` (the default) once it's present.
				'@fontsource-variable/bricolage-grotesque/standard.css',
				'./src/styles/theme.css',
				'./src/styles/landing.css',
			],
		}),
	],
});
