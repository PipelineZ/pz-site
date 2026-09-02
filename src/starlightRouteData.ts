import { defineRouteMiddleware } from '@astrojs/starlight/route-data';
import type { SidebarEntry } from '@astrojs/starlight/route-data';

/**
 * Two sections, two sidebars.
 *
 * The topbar offers Documentation and Book as separate destinations, so the sidebar under
 * one must never list the other: a /book/ page shows only the series, every other page
 * shows only the docs tree.
 *
 * A group counts as the book when it contains a link into /book/ — content, not a label,
 * decides, so renaming the sidebar group cannot silently un-split the two sections.
 *
 * Registered by `src/plugins/sections.ts` with `order: 'post'`, so it runs after
 * starlight-versions has picked the sidebar of the version being read.
 */
const isBookEntry = (entry: SidebarEntry): boolean =>
	entry.type === 'link' ? entry.href.startsWith('/book') : entry.entries.some(isBookEntry);

/** Sidebar order, depth-first — the order a reader pages through with prev/next. */
const flatten = (entries: SidebarEntry[]): Extract<SidebarEntry, { type: 'link' }>[] =>
	entries.flatMap((entry) => (entry.type === 'link' ? [entry] : flatten(entry.entries)));

export const onRequest = defineRouteMiddleware((context) => {
	const route = context.locals.starlightRoute;
	const inBook = context.url.pathname.replace(import.meta.env.BASE_URL, '/').startsWith('/book');

	route.sidebar = route.sidebar.filter((entry) => isBookEntry(entry) === inBook);

	// Pagination is derived from the full sidebar, so without this the last docs page still
	// links "next" into the book, reconnecting the two sections we just separated.
	const links = flatten(route.sidebar);
	const index = links.findIndex((link) => link.isCurrent);
	if (index === -1) return;
	route.pagination = {
		prev: links[index - 1],
		next: links[index + 1],
	};
});
