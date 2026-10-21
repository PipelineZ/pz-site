// A post is published once its date has arrived. Until then it stays out of the build entirely:
// no gallery card, no page, and none of its images. The deploy workflow rebuilds daily, so posts
// go live on their own. Set PZ_SHOW_SCHEDULED=1 to include scheduled posts when previewing locally.
const showScheduled = process.env.PZ_SHOW_SCHEDULED === '1';

export function isPublished(date: Date): boolean {
	return showScheduled || date.valueOf() <= Date.now();
}
