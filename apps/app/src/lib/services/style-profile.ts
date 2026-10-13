import { validateRuleBudget } from './preference-contract';
export type StyleProfile = {
	id: string; name: string; scope: 'all' | 'app' | 'category'; target: string; instructions: string;
};
export function selectStyleProfile(
	profiles: StyleProfile[], categories: {app: string; category: string}[], app: string,
) {
	const normalize = (value: string) => value.trim().toLowerCase();
	const category = categories.find(row => normalize(row.app) === normalize(app))?.category;
	// Exact app overrides an explicitly assigned category, which overrides the general default.
	const profile = profiles.find(p => p.scope === 'app' && normalize(p.target) === normalize(app))
		?? profiles.find(p => p.scope === 'category' && !!category && normalize(p.target) === normalize(category))
		?? profiles.find(p => p.scope === 'all');
	if (!profile) return undefined;
	validateRuleBudget([profile.instructions], true);
	return { instructions: profile.instructions, scope: `${profile.scope}:${profile.target || 'all'}` };
}
