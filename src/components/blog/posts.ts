import { getCollection, type CollectionEntry } from 'astro:content';
import { isPublished } from './schedule';

/** Published blog posts, newest first. */
export async function getPublishedPosts(): Promise<CollectionEntry<'blog'>[]> {
	// The blog loader already drops scheduled posts; this repeats the check for entries the dev
	// server's file watcher re-adds after the initial load.
	const posts = await getCollection('blog', (post) => isPublished(post.data.date));
	return posts.sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}
