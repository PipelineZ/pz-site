// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import catppuccin from '@catppuccin/starlight';

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
			description: 'A dbt-inspired batch ETL CLI for .NET powered by DuckDB.',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/coccor/pz' },
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
						{ label: 'Performance', link: '/performance/' },
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
			plugins: [
				catppuccin({
					dark: { flavor: 'mocha', accent: 'teal' },
					light: { flavor: 'latte', accent: 'teal' },
				}),
			],
			customCss: [
				'@fontsource-variable/bricolage-grotesque',
				'./src/styles/landing.css',
			],
			head: [
				{
					tag: 'script',
					attrs: { type: 'module' },
					content: `
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
const sources = [];
document.querySelectorAll('pre[data-language="mermaid"]').forEach((pre, i) => {
	const host = pre.closest('.expressive-code') ?? pre;
	const div = document.createElement('div');
	div.id = 'mmd-' + i;
	const lines = pre.querySelectorAll('.ec-line .code');
	const code = lines.length
		? [...lines].map((l) => l.textContent).join('\\n')
		: pre.textContent;
	sources.push({ div, code });
	host.replaceWith(div);
});
let lastTheme;
async function render() {
	const dark = document.documentElement.dataset.theme !== 'light';
	if (dark === lastTheme) return;
	lastTheme = dark;
	mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default' });
	for (const { div, code } of sources) {
		const { svg } = await mermaid.render(div.id.replace('-', 's') + 'svg', code);
		div.innerHTML = svg;
	}
}
if (sources.length) {
	render();
	new MutationObserver(render).observe(document.documentElement, {
		attributes: true,
		attributeFilter: ['data-theme'],
	});
}
`,
				},
			],
		}),
	],
});
