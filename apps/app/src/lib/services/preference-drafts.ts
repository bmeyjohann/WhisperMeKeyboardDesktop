import { settings } from '$lib/stores/settings.svelte';
import { parsePreferenceSuggestion } from './preference-contract';

export function rememberVoiceApp(app: string) {
	if (!app.trim() || app === 'unknown' || app.length > 500 || settings.value['voiceInput.lastAppIdentifier'] === app) return;
	settings.value = {...settings.value, 'voiceInput.lastAppIdentifier': app};
}

/** Draft storage is local and separate from saved rules. Only a user Save may call /preferences. */
export function receivePreferenceSuggestions(response: {preferenceSuggestion?: unknown; preferenceSuggestions?: unknown}, app: string, enabled: boolean) {
	if (!enabled) return 0;
	const incoming = Array.isArray(response.preferenceSuggestions) ? response.preferenceSuggestions : [response.preferenceSuggestion];
	const drafts = [...(settings.value['voiceInput.preferenceDrafts'] || [])];
	let added = 0;
	for (const value of incoming) {
		const draft = parsePreferenceSuggestion(value, app);
		if (!draft || drafts.length >= 20 || drafts.some(saved => saved.ruleText === draft.ruleText && saved.scope === draft.scope && saved.appIdentifier === draft.appIdentifier && saved.categoryId === draft.categoryId)) continue;
		drafts.push({...draft, id: crypto.randomUUID()}); added++;
	}
	if (added) settings.value = {...settings.value, 'voiceInput.preferenceDrafts': drafts};
	return added;
}
