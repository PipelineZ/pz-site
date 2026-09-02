#!/usr/bin/env node
// Checks that every versioned docs page under src/content/docs/ parses as MDX.
//
// The starlight-versions plugin, when it freezes a version, copies every
// non-excluded page and parses each one with remark + remark-directive +
// remark-mdx + remark-frontmatter, even plain .md files. MDX is stricter
// than Markdown: an unclosed void HTML tag (e.g. `<img ...>` instead of
// `<img ... />`) or a bare `<word>` in prose breaks the parse. If any page
// fails, the freeze cannot run — this check catches that before release
// day instead of on it.
//
// Usage: node scripts/check-mdx-safe.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { remark } from 'remark';
import remarkDirective from 'remark-directive';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMdx from 'remark-mdx';

const root = fileURLToPath(new URL('../src/content/docs/', import.meta.url));

// Mirrors the `exclude` list passed to starlight-versions in astro.config.mjs:
// the landing page and the book series are not release-bound and are never
// copied by the freeze, so they don't need to parse as MDX.
const EXCLUDED = {
	files: new Set(['index.mdx']),
	dirs: new Set(['book']),
};

const files = [];
(function walk(dir) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		const rel = relative(root, path);
		if (statSync(path).isDirectory()) {
			if (EXCLUDED.dirs.has(rel)) continue;
			walk(path);
		} else if (/\.mdx?$/.test(name) && !EXCLUDED.files.has(rel)) {
			files.push(path);
		}
	}
})(root);

const processor = remark().use(remarkDirective).use(remarkMdx).use(remarkFrontmatter);

let failures = 0;
for (const file of files) {
	try {
		await processor.process(readFileSync(file, 'utf8'));
	} catch (error) {
		failures++;
		console.log(`${relative(root, file)}: ${error.message.split('\n')[0]}`);
	}
}

if (failures > 0) {
	console.log(`check-mdx-safe: ${failures} of ${files.length} pages would fail the version freeze`);
	process.exit(1);
} else {
	console.log(`check-mdx-safe: ok (${files.length} pages)`);
}
