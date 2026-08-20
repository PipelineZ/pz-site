import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

/**
 * /llms.txt — the machine-readable index of this site, per the llmstxt.org convention.
 *
 * This is a contract, not a nicety: `pz mcp`'s list_docs and search_docs tools read this file
 * to answer without shipping a copy of the documentation inside the CLI. Changing the shape
 * here changes what an agent connected to `pz` can find, so keep the "- [title](url): summary"
 * line format stable and let the set of lines vary instead.
 */

const SITE = 'https://pipelinez.dev';

/** Sidebar-ish grouping, so an agent reading top-to-bottom meets concepts before how-tos. */
const GROUPS: Array<{ label: string; match: (id: string) => boolean }> = [
	{ label: 'Start here', match: (id) => ['docs', 'quickstart', 'getting-started'].includes(id) },
	{ label: 'Concepts', match: (id) => id.startsWith('concepts/') },
	{ label: 'How-to guides', match: (id) => id.startsWith('how-to/') },
	{ label: 'Reference', match: (id) => id.startsWith('reference/') || ['events', 'performance', 'versioning'].includes(id) },
	{ label: 'Diagrams', match: (id) => id.startsWith('diagrams/') },
	{ label: 'Articles', match: (id) => id.startsWith('articles/') },
];

const urlFor = (id: string) => (id === 'docs' ? `${SITE}/docs/` : `${SITE}/${id}/`);

export const GET: APIRoute = async () => {
	const docs = await getCollection('docs');
	// The splash landing page is not documentation; it would only add a contentless entry.
	const pages = docs.filter((d) => d.id !== 'index');

	const lines: string[] = [
		'# PipelineZ (pz)',
		'',
		'> A lightweight, developer-first CLI for batch ETL/ELT, powered by DuckDB. Describe a',
		'> pipeline as plain SQL files plus one connections.yml; pz compiles them into a',
		'> dependency-ordered DAG and runs it in-process, moving data as zero-copy Arrow.',
		'',
	];

	const seen = new Set<string>();
	for (const group of GROUPS) {
		const inGroup = pages
			.filter((p) => group.match(p.id))
			.sort((a, b) => a.id.localeCompare(b.id));
		if (inGroup.length === 0) continue;
		lines.push(`## ${group.label}`, '');
		for (const page of inGroup) {
			seen.add(page.id);
			const summary = page.data.description ? `: ${page.data.description}` : '';
			lines.push(`- [${page.data.title}](${urlFor(page.id)})${summary}`);
		}
		lines.push('');
	}

	// Anything a future directory adds still gets listed rather than silently dropped.
	const rest = pages.filter((p) => !seen.has(p.id)).sort((a, b) => a.id.localeCompare(b.id));
	if (rest.length > 0) {
		lines.push('## Other', '');
		for (const page of rest) {
			const summary = page.data.description ? `: ${page.data.description}` : '';
			lines.push(`- [${page.data.title}](${urlFor(page.id)})${summary}`);
		}
		lines.push('');
	}

	lines.push('## Full text', '', `- [All pages, full markdown](${SITE}/llms-full.txt)`, '');

	return new Response(lines.join('\n'), {
		headers: { 'Content-Type': 'text/plain; charset=utf-8' },
	});
};
