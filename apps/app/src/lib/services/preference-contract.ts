// IDs are a wire contract. Labels are presentation only; legacy local targets remain valid.
export const APP_CATEGORIES = [
	{ id: 'personal', name: 'Personal/social' },
	{ id: 'business', name: 'Business/work' },
	{ id: 'development', name: 'Development' },
	{ id: 'writing', name: 'Writing/publishing' },
	{ id: 'productivity', name: 'Notes/planning' },
	{ id: 'education', name: 'Study/learning' },
	{ id: 'other', name: 'Other' },
] as const;
export type CategoryId = typeof APP_CATEGORIES[number]['id'];
export type PreferenceSuggestion = {
	kind: 'preference' | 'dictionary';
	ruleText: string; scope: 'app' | 'category' | 'all';
	appIdentifier?: string; categoryId?: CategoryId; name?: string; scopeReason?: string;
	requiresConfirmation?: boolean; scopeLocked?: boolean;
};
export const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;
export const estimatedTokens = (bytes: number) => Math.ceil(bytes / 4);
export function deduplicateDictionary(entries: string[]) {
	const seen = new Set<string>();
	return entries.map(entry => entry.trim()).filter(entry => {
		const key = entry.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key); return true;
	});
}
export function isCategoryId(value: unknown): value is CategoryId {
	return APP_CATEGORIES.some(category => category.id === value);
}
export function categoryLabel(id: string) {
	return APP_CATEGORIES.find(category => category.id === id)?.name || `${id} (legacy local category)`;
}
export function appCategoryFor(mappings: {app: string; category: string}[], app: string) {
	const category = mappings.find(row => row.app.trim().toLowerCase() === app.trim().toLowerCase())?.category;
	return isCategoryId(category) ? category : undefined;
}
export function validateDictionary(entries: string[]) {
	if (entries.length > 100) throw new Error('Dictionary allows at most 100 entries.');
	if (entries.some(entry => !entry.trim() || entry.length > 80 || /[\x00-\x1f]/.test(entry))) throw new Error('Each dictionary entry must contain 1–80 characters, without control characters.');
	if (utf8Bytes(entries.join('')) > 4096) throw new Error('Dictionary exceeds 4,096 UTF-8 bytes (about 1,024 tokens).');
	return entries;
}
export function validateRule(text: string) {
	if (!text.trim() || text.length > 2000 || utf8Bytes(text) > 8000) throw new Error('A writing rule must contain 1–2,000 characters and at most 8,000 UTF-8 bytes.');
	return text;
}
export function validateRuleBudget(texts: string[], active = false) {
	texts.forEach(validateRule);
	if (!active && texts.length > 100) throw new Error('At most 100 saved writing rules are allowed.');
	const cap = active ? 16000 : 64000;
	if (texts.reduce((bytes, text) => bytes + utf8Bytes(text), 0) > cap) throw new Error(`${active ? 'Active' : 'Saved'} writing rules exceed ${cap.toLocaleString('en-US')} UTF-8 bytes${active ? ' (about 4,000 tokens)' : ''}.`);
}
export function validateSamples(samples: string[]) {
	if (!samples.length || samples.length > 5 || samples.some(sample => !sample.trim()) || samples.reduce((total, sample) => total + sample.length, 0) > 12000) throw new Error('Use 1–5 nonempty examples, with at most 12,000 characters in total.');
	return samples;
}
/** Reject invalid AI targets. A suggestion can only target the captured app, a known category, or all apps. */
export function parsePreferenceSuggestion(value: unknown, app: string): PreferenceSuggestion | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const row = value as Record<string, unknown>;
	const text = row.text ?? row.ruleText ?? row.rule_text ?? row.instructions;
	if (typeof text !== 'string') return undefined;
	if (row.kind === 'dictionary') {
		try { validateDictionary([text]); } catch { return undefined; }
		return {kind: 'dictionary', ruleText: text, scope: 'all', requiresConfirmation: row.requiresConfirmation === true};
	}
	if (row.kind !== undefined && row.kind !== 'preference') return undefined;
	try { validateRule(text); } catch { return undefined; }
	const scope = row.scope ?? (app && app !== 'unknown' ? 'app' : undefined);
	if (!['app', 'category', 'all'].includes(String(scope))) return undefined;
	if (row.scopeLocked !== undefined && typeof row.scopeLocked !== 'boolean') return undefined;
	if ((row.scopeLocked ?? row.requiresConfirmation) === true && scope !== 'app') return undefined;
	if (row.scope === 'category' && !isCategoryId(row.categoryId)) return undefined;
	if (scope === 'app' && (!app.trim() || app === 'unknown' || (row.appIdentifier !== undefined && row.appIdentifier !== app))) return undefined;
	if (scope !== 'category' && row.categoryId !== undefined) return undefined;
	if (scope !== 'app' && row.appIdentifier !== undefined) return undefined;
	if (row.name !== undefined && (typeof row.name !== 'string' || row.name.length > 100)) return undefined;
	if (row.scopeReason !== undefined && (typeof row.scopeReason !== 'string' || row.scopeReason.length > 1000)) return undefined;
	return {
		kind: 'preference', ruleText: text, scope: scope as PreferenceSuggestion['scope'],
		...(typeof row.requiresConfirmation === 'boolean' ? {requiresConfirmation: row.requiresConfirmation} : {}),
		...(typeof row.scopeLocked === 'boolean' ? {scopeLocked: row.scopeLocked} : {}),
		...(scope === 'app' ? {appIdentifier: app} : {}),
		...(scope === 'category' ? {categoryId: row.categoryId as CategoryId} : {}),
		...(typeof row.name === 'string' ? {name: row.name} : {}),
		...(typeof row.scopeReason === 'string' ? {scopeReason: row.scopeReason} : {}),
	};
}
export function preferenceScopeLabel(scope: string, target = '') {
	return scope === 'all' ? 'All apps' : scope === 'category' ? categoryLabel(target) : `App: ${target}`;
}
export type RuleApp = {app_identifier?: string; app_platform?: string; scope?: string; categoryId?: string; appIdentifier?: string};
export function savedRuleScopeLabel(apps?: RuleApp[]) {
	return apps?.map(app => app.scope ? preferenceScopeLabel(app.scope, app.categoryId || app.appIdentifier || app.app_identifier || '')
		: app.app_identifier?.startsWith('category:') ? categoryLabel(app.app_identifier.slice(9))
		: app.app_identifier === '*' ? 'All apps' : `App: ${app.app_identifier || 'unknown'}`).join(', ') || 'No app assigned';
}
/** This marker controls insertion, independently of the UI's Save requirement for every draft. */
export function isNoticeOnlyResponse(response: {preferenceSuggestion?: unknown}) {
	const candidate = response.preferenceSuggestion as {requiresConfirmation?: boolean} | undefined;
	return candidate?.requiresConfirmation === true;
}
export type PersonalizationSettings = {
	'voiceInput.usePreferences'?: boolean; 'voiceInput.useDictionary'?: boolean;
	'voiceInput.dictionary'?: string[]; 'voiceInput.suggestPreferences'?: boolean;
	'voiceInput.appCategories'?: {app: string; category: string}[];
};
export function personalizationOptions(settings: PersonalizationSettings, app: string) {
	return {
		dictionary: settings['voiceInput.useDictionary'] === true ? validateDictionary(deduplicateDictionary(settings['voiceInput.dictionary'] || [])) : [],
		suggestPreferences: settings['voiceInput.suggestPreferences'] === true,
		appCategory: appCategoryFor(settings['voiceInput.appCategories'] || [], app),
	};
}
