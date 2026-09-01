// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

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
	'11-pz-limitations',
];

// https://astro.build/config
export default defineConfig({
	site: 'https://pipelinez.dev',
	redirects: Object.fromEntries(
		bookPages.map((page) => [`/articles/${page}`, `/book/${page}`])
	),
	integrations: [
		starlight({
			title: 'PipelineZ',
			logo: { src: './src/assets/pz-logo.svg', alt: 'PipelineZ', replacesTitle: true },
			description:
				'A lightweight, developer-first batch data pipeline engine for SQL-based ETL/ELT, powered by DuckDB, that can run anywhere without requiring a data platform.',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/PipelineZ/pz' },
			],
			sidebar: [
				{
					label: 'Start here',
					items: [
						{ label: 'Documentation', link: '/docs/' },
						{ label: 'Quickstart', link: '/quickstart/' },
					],
				},
				{ label: 'Concepts', items: [{ autogenerate: { directory: 'concepts' } }] },
				{ label: 'How-to', items: [{ autogenerate: { directory: 'how-to' } }] },
				{
					label: 'Reference',
					items: [
						{ autogenerate: { directory: 'reference' } },
						{ label: 'Event stream', link: '/events/' },
						{ label: 'Versioning', link: '/versioning/' },
					],
				},
				{ label: 'Diagrams', items: [{ autogenerate: { directory: 'diagrams' } }] },
				{
					label: 'Data Pipelines: An Article Series',
					items: [{ autogenerate: { directory: 'book' } }],
				},
			],
			components: {
				Header: './src/components/Header.astro',
				Sidebar: './src/components/Sidebar.astro',
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
