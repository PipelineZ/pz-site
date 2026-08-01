// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import catppuccin from '@catppuccin/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://coccor.github.io',
	base: '/pipelinez-site',
	integrations: [
		starlight({
			title: 'PipelineZ',
			description: 'A dbt-inspired batch ETL CLI for .NET powered by DuckDB.',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/coccor/pz' },
			],
			sidebar: [
				{
					label: 'The Little Book of Data Pipelines',
					items: [{ autogenerate: { directory: 'book' } }],
				},
			],
			plugins: [catppuccin()],
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
