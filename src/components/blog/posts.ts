import { getCollection, type CollectionEntry } from 'astro:content';

// A post dated in the future stays out of the build, both from the gallery and as a page, until
// a build runs on or after its date. The deploy workflow rebuilds daily, so posts go live on their
// own. Set PZ_SHOW_SCHEDULED=1 to include scheduled posts when previewing locally.
const showScheduled = process.env.PZ_SHOW_SCHEDULED === '1';

/** Published blog posts, newest first. */
export async function getPublishedPosts(): Promise<CollectionEntry<'blog'>[]> {
	const now = Date.now();
	const posts = await getCollection(
		'blog',
		(post) => showScheduled || post.data.date.valueOf() <= now
	);
	return posts.sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}
