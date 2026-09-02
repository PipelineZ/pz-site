import versionsFile from '../versions.json';

/**
 * The archived documentation versions, newest first, as listed in `versions.json`.
 *
 * `versions.json` is the single source of truth: the freeze script appends to it, the CI guard
 * checks it against the committed snapshots, and `astro.config.mjs` registers the version
 * plugin from it. Site code reads it through here so nothing else parses the file.
 */
export interface DocsVersion {
	/** URL segment and directory name, e.g. `v0.4`. */
	slug: string;
	/** Dropdown label, e.g. `v0.4`. */
	label: string;
}

export const archivedVersions: DocsVersion[] = versionsFile.versions;

export const archivedSlugs: string[] = archivedVersions.map((v) => v.slug);

/** True for a content-collection id that belongs to an archived version (`v0.4/reference/cli`). */
export const isArchivedId = (id: string): boolean =>
	archivedSlugs.some((slug) => id === slug || id.startsWith(`${slug}/`));

/**
 * Splits a base-less pathname into the archive it belongs to and the path inside it.
 * `/v0.4/guides/` → `{ version: 'v0.4', rest: '/guides/' }`; `/guides/` → `{ version: undefined, rest: '/guides/' }`.
 */
export const splitVersion = (path: string): { version: string | undefined; rest: string } => {
	const [, first = ''] = path.split('/');
	if (!archivedSlugs.includes(first)) return { version: undefined, rest: path };
	const rest = path.slice(first.length + 1);
	return { version: first, rest: rest === '' ? '/' : rest };
};
