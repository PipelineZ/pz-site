import type { StarlightPlugin } from '@astrojs/starlight/types';

/**
 * Registers the book/docs sidebar split (`src/starlightRouteData.ts`) as route middleware that
 * runs AFTER every other plugin's middleware.
 *
 * Starlight runs the `routeMiddleware` config entries before plugin middleware. Registered that
 * way, the split would see starlight-versions' wrapped sidebar (one group per version, each
 * holding the whole tree) and hide the entire current-version group on docs pages. With
 * `order: 'post'` it sees the sidebar of the version being read and filters that.
 */
export default function sections(): StarlightPlugin {
	return {
		name: 'pz-sections',
		hooks: {
			'config:setup'({ addRouteMiddleware }) {
				addRouteMiddleware({ entrypoint: './src/starlightRouteData.ts', order: 'post' });
			},
		},
	};
}
