import { defineCollection, z } from 'astro:content';
import { docsLoader, i18nLoader } from '@astrojs/starlight/loaders';
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema';
import { glob, type Loader } from 'astro/loaders';
import { isPublished } from './components/blog/schedule';

// Drops scheduled posts at load time, before Astro processes their images, so nothing of a post
// reaches the build until its date.
function publishedOnly(loader: Loader): Loader {
	return {
		...loader,
		load: async (context) => {
			await loader.load(context);
			for (const [id, entry] of context.store.entries()) {
				if (!isPublished(new Date(entry.data.date as string | Date))) context.store.delete(id);
			}
		},
	};
}

export const collections = {
	docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
	i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
	blog: defineCollection({
		loader: publishedOnly(glob({ pattern: '**/*.{md,mdx}', base: './src/content/blog' })),
		schema: ({ image }) =>
			z.object({
				title: z.string(),
				description: z.string(),
				date: z.coerce.date(),
				heroImage: z.object({
					dark: image(),
					light: image(),
					alt: z.string(),
				}),
			}),
	}),
};
