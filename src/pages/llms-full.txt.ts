import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { isArchivedId } from '../versions';

/**
 * /llms-full.txt — every documentation page's full markdown in one file.
 *
 * `pz mcp`'s get_doc serves page bodies out of this, so the delimiter line below is parsed,
 * not decorative. Each page is introduced by a line of the exact form:
 *
 *     ===== pz-doc: <slug> | <url> =====
 *
 * Keep that shape stable. A slug here matches the one /llms.txt reports for the same page.
 */

const SITE = 'https://pipelinez.dev';
const urlFor = (id: string) => (id === 'docs' ? `${SITE}/docs/` : `${SITE}/${id}/`);

export const GET: APIRoute = async () => {
	const docs = await getCollection('docs');
	// Current version only, as in llms.txt: `pz mcp` must never serve an archived page as current.
	const pages = docs
		.filter((d) => d.id !== 'index' && !isArchivedId(d.id))
		.sort((a, b) => a.id.localeCompare(b.id));

	const chunks: string[] = [
		'# PipelineZ (pz) — complete documentation',
		'',
		`Generated from ${SITE}. Index with per-page summaries: ${SITE}/llms.txt`,
		'',
	];

	for (const page of pages) {
		chunks.push(
			`===== pz-doc: ${page.id} | ${urlFor(page.id)} =====`,
			'',
			`# ${page.data.title}`,
			'',
			page.body?.trim() ?? '',
			'',
		);
	}

	return new Response(chunks.join('\n'), {
		headers: { 'Content-Type': 'text/plain; charset=utf-8' },
	});
};
