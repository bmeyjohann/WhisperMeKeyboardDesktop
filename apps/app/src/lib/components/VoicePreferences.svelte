<script lang="ts">
	import { settings } from '$lib/stores/settings.svelte';
	import { auth0Service } from '$lib/services/auth0';
	import { invoke } from '@tauri-apps/api/core';
	import { platform } from '@tauri-apps/plugin-os';
	import { llmRoutingOptions } from '$lib/constants/transcription/backend-provider-config';
	import type { StyleProfile } from '$lib/services/style-profile';
	import { APP_CATEGORIES, appCategoryFor, categoryLabel, deduplicateDictionary, isCategoryId, parsePreferenceSuggestion, preferenceScopeLabel, savedRuleScopeLabel, validateDictionary, validateRule, validateRuleBudget, validateSamples, utf8Bytes, estimatedTokens, type RuleApp } from '$lib/services/preference-contract';
	import { reportBudgetStatus, voiceBudgetWarning } from '$lib/services/voice-feedback';

	type SavedRule = {id: number; name: string; rule_text: string; apps?: RuleApp[]};
	let name = $state('My style');
	let scope = $state<StyleProfile['scope']>('all');
	let target = $state('');
	let instructions = $state('');
	let samples = $state(['']);
	let editingId = $state('');
	let draftId = $state('');
	let storage = $state<'local' | 'account'>('account');
	let scopeReason = $state('');
	let currentApp = $state('');
	let app = $state('');
	let category = $state('business');
	let dictionaryText = $state(settings.value['voiceInput.dictionary'].join('\n'));
	let busy = $state(false);
	let message = $state('');
	let rules = $state<SavedRule[]>([]);
	const dictionaryEntries = $derived(dictionaryText.split(/\r?\n/).map(word => word.trim()).filter(Boolean));
	const dictionaryBytes = $derived(utf8Bytes(dictionaryEntries.join('')));
	const sampleCharacters = $derived(samples.reduce((total, sample) => total + sample.length, 0));
	const reviewedDraft = $derived(settings.value['voiceInput.preferenceDrafts'].find(draft => draft.id === draftId));
	const scopeLocked = $derived(reviewedDraft?.scopeLocked ?? reviewedDraft?.requiresConfirmation ?? false);
	const capturedApp = $derived(currentApp.trim() || settings.value['voiceInput.lastAppIdentifier']);

	async function request(path: string, method: string, body?: unknown): Promise<any> {
		const token = await auth0Service.getVoiceAccessToken();
		if (!token) throw new Error('Sign in before managing account writing rules.');
		const result: any = await invoke('voice_preferences_request', {endpoint: settings.value['voiceInput.endpoint'], token, path, method, body});
		reportBudgetStatus(result.budget || result.failure?.budget);
		if (result.success === false) throw new Error(result.error || 'Preferences request failed');
		return result;
	}
	async function run(action: () => Promise<void> | void) {
		busy = true; message = '';
		try { await action(); } catch (error) { message = error instanceof Error ? error.message : String(error); } finally { busy = false; }
	}
	async function loadRules() {
		const response = await request('/preferences', 'GET');
		if (!Array.isArray(response.rules)) throw new Error('Server returned an invalid writing rule list.');
		rules = response.rules;
		return rules;
	}
	function discardDraft(id: string) {
		settings.value = {...settings.value, 'voiceInput.preferenceDrafts': settings.value['voiceInput.preferenceDrafts'].filter(draft => draft.id !== id)};
		if (draftId === id) {draftId = ''; instructions = ''; scopeReason = '';}
	}
	function saveDictionary() {
		const entries = deduplicateDictionary(dictionaryEntries); validateDictionary(entries);
		settings.value = {...settings.value, 'voiceInput.dictionary': entries};
		dictionaryText = entries.join('\n');
		message = 'Dictionary saved on this device. The dictionary switch keeps your chosen setting.';
	}
	function saveDictionaryDraft(id: string, text: string) {
		const entries = deduplicateDictionary([...settings.value['voiceInput.dictionary'], text.trim()]);
		validateDictionary(entries);
		settings.value = {...settings.value, 'voiceInput.dictionary': entries};
		dictionaryText = entries.join('\n'); discardDraft(id);
		message = 'Word saved locally. The dictionary switch keeps your chosen setting.';
	}
	function editProfile(profile: StyleProfile) {
		editingId = profile.id; draftId = ''; storage = 'local'; name = profile.name; scope = profile.scope; target = profile.target; instructions = profile.instructions; scopeReason = '';
	}
	function reviewDraft(draft: typeof settings.value['voiceInput.preferenceDrafts'][number]) {
		draftId = draft.id; editingId = ''; storage = 'account'; name = draft.name || 'Writing rule'; scope = draft.scope; target = draft.categoryId || draft.appIdentifier || ''; instructions = draft.ruleText; scopeReason = draft.scopeReason || '';
	}
	function validateTarget() {
		if (scopeLocked && (scope !== reviewedDraft?.scope || target !== reviewedDraft?.appIdentifier)) throw new Error('This legacy confirmation is restricted to its captured app.');
		if (!name.trim() || name.length > 80) throw new Error('Enter a name with at most 80 characters.');
		validateRule(instructions);
		if (scope === 'category' && !isCategoryId(target) && !(storage === 'local' && editingId && settings.value['voiceInput.styleProfiles'].some(profile => profile.id === editingId && profile.target === target))) throw new Error('Choose a category from the catalog.');
		if (scope === 'app' && (!target.trim() || target.trim() === '*' || target.startsWith('category:') || target.length > (storage === 'account' ? 200 : 500))) throw new Error('Enter a valid app identifier. Account rules allow up to 200 characters.');
	}
	async function saveWritingRule() {
		if (scope === 'app' && !target.trim() && capturedApp) target = capturedApp;
		validateTarget();
		const effectiveTarget = scope === 'all' ? '' : target.trim();
		if (storage === 'local') {
			const profiles = settings.value['voiceInput.styleProfiles'];
			if (profiles.some(profile => profile.id !== editingId && profile.scope === scope && profile.target.toLowerCase() === effectiveTarget.toLowerCase())) throw new Error('A local profile already uses this scope. Edit that profile or save this as an account writing rule.');
			const rest = profiles.filter(profile => profile.id !== editingId);
			validateRuleBudget([...rest.map(profile => profile.instructions), instructions, ...rules.map(rule => rule.rule_text)]);
			settings.value = {...settings.value, 'voiceInput.styleProfiles': [...rest, {id: editingId || crypto.randomUUID(), name: name.trim(), scope, target: effectiveTarget, instructions: instructions.trim()}]};
			message = 'Writing profile saved locally. The preferences switch keeps your chosen setting.';
		} else {
			const saved = await loadRules();
			validateRuleBudget([...saved.map(rule => rule.rule_text), ...settings.value['voiceInput.styleProfiles'].map(profile => profile.instructions), instructions]);
			await request('/preferences', 'POST', {name: name.trim(), rule_text: instructions.trim(), scope, ...(scope === 'category' ? {categoryId: target} : scope === 'app' ? {appIdentifier: effectiveTarget, platform: platform()} : {})});
			message = 'Writing rule saved to your account. The preferences switch keeps your chosen setting.';
			await loadRules();
		}
		if (draftId) discardDraft(draftId);
		editingId = ''; draftId = ''; samples = ['']; storage = 'account';
	}
	async function extractStyle() {
		const examples = validateSamples(samples);
		const extractionApp = capturedApp;
		const result = await request('/style-profile', 'POST', {samples: examples, appIdentifier: extractionApp || undefined, appCategory: appCategoryFor(settings.value['voiceInput.appCategories'], extractionApp), ...llmRoutingOptions(settings.value['voiceInput.llmRouting'], settings.value['voiceInput.llmProvider'], settings.value['voiceInput.llmModel'], settings.value['voiceInput.reasoningEffort'])});
		// Samples live only in this view and the extraction request. Never store them in a profile or trace.
		samples = [''];
		if (typeof result.instructions !== 'string') throw new Error('Server returned an invalid style extraction.');
		validateRule(result.instructions);
		instructions = result.instructions; editingId = ''; draftId = '';
		if (result.scope !== undefined) {
			const recommendation = parsePreferenceSuggestion({...result, kind: 'preference', requiresConfirmation: false, scopeLocked: false}, extractionApp);
			if (!recommendation) throw new Error('Invalid scope recommendation. Review the instructions and choose a scope yourself.');
			name = recommendation.name || 'My style'; scope = recommendation.scope; target = recommendation.categoryId || recommendation.appIdentifier || ''; scopeReason = recommendation.scopeReason || '';
		} else {scopeReason = '';}
		message = 'Review the extracted instructions and recommended scope, then Save. Nothing has been saved.';
	}
	async function updateAccountRule(rule: SavedRule) {
		const saved = await request('/preferences', 'GET');
		validateRuleBudget([...saved.rules.filter((row: SavedRule) => row.id !== rule.id).map((row: SavedRule) => row.rule_text), rule.rule_text, ...settings.value['voiceInput.styleProfiles'].map(profile => profile.instructions)]);
		await request('/preferences', 'PUT', {id: rule.id, name: rule.name, rule_text: rule.rule_text}); await loadRules(); message = 'Writing rule saved.';
	}
</script>

<section class="preferences">
	<h3>Dictionary and writing rules</h3>
	{#if $voiceBudgetWarning}<p role="status">{$voiceBudgetWarning}</p>{/if}
	<label><input type="checkbox" checked={settings.value['voiceInput.useDictionary']} onchange={e => settings.value = {...settings.value, 'voiceInput.useDictionary': e.currentTarget.checked}} /> Use my local dictionary</label>
	<p>Off by default. When enabled, these words and names are sent as speech and text hints. Saved on this device.</p>
	<details><summary>Dictionary words and names</summary>
		<label>One word or short name per line <textarea rows="5" bind:value={dictionaryText} placeholder="WhisperMe&#10;MEYJOHANN"></textarea></label>
		<p>{dictionaryEntries.length}/100 entries · {dictionaryBytes}/4,096 UTF-8 bytes · about {estimatedTokens(dictionaryBytes)} tokens. Each entry allows 80 characters.</p>
		<button disabled={busy} onclick={() => run(saveDictionary)}>Save dictionary locally</button>
	</details>
	<label><input type="checkbox" checked={settings.value['voiceInput.usePreferences']} onchange={e => settings.value = {...settings.value, 'voiceInput.usePreferences': e.currentTarget.checked}} /> Use saved writing rules and styles</label>
	<p>Off by default. Say “Whisper Me, remember…” to explicitly save an existing memory preference when enabled. Saving a draft keeps this switch unchanged.</p>
	<label><input type="checkbox" checked={settings.value['voiceInput.suggestPreferences']} onchange={e => settings.value = {...settings.value, 'voiceInput.suggestPreferences': e.currentTarget.checked}} /> Offer dictionary and writing rule drafts from voice</label>
	<p>Off by default. Every offered spelling, style or punctuation draft requires your Save. Review it here before future use.</p>
	{#if settings.value['voiceInput.preferenceDrafts'].length}
		<h4>Drafts to review</h4>
		{#each settings.value['voiceInput.preferenceDrafts'] as draft (draft.id)}
			<div class="rule">
				{#if draft.kind === 'dictionary'}
					<label>Dictionary word · local to this device <input maxlength="80" bind:value={draft.ruleText} /></label>
					<div class="row"><button disabled={busy} onclick={() => run(() => saveDictionaryDraft(draft.id, draft.ruleText))}>Save word locally</button><button onclick={() => discardDraft(draft.id)}>Discard</button></div>
				{:else}
					<p>{draft.name || 'Writing rule'} · {preferenceScopeLabel(draft.scope, draft.categoryId || draft.appIdentifier)}<br />{draft.ruleText}</p>
					{#if draft.scopeReason}<p>{draft.scopeReason}</p>{/if}
					<div class="row"><button onclick={() => reviewDraft(draft)}>Review and edit</button><button onclick={() => discardDraft(draft.id)}>Discard</button></div>
				{/if}
			</div>
		{/each}
	{/if}
	<details open={!!draftId}><summary>Writing rules, punctuation and style</summary>
		<p>Local profiles: exact app overrides its assigned category, then all apps. Account rules: all apps, category and app rules combine. App identifiers appear in transcript details. You control category assignments.</p>
		<details><summary>Advanced: existing local profiles</summary>
		{#each settings.value['voiceInput.styleProfiles'] as profile (profile.id)}
			<div class="row"><span>{profile.name} · {preferenceScopeLabel(profile.scope, profile.target)} · local profile</span><button onclick={() => editProfile(profile)}>Edit</button><button onclick={() => settings.value = {...settings.value, 'voiceInput.styleProfiles': settings.value['voiceInput.styleProfiles'].filter(p => p.id !== profile.id)}}>Delete</button></div>
		{/each}
		</details>
		<h4>{draftId ? 'Review writing rule draft' : editingId ? 'Edit local profile' : 'New writing rule or style'}</h4>
		<label>Name <input maxlength="80" bind:value={name} /></label>
		{#if editingId}<p>Editing an existing local profile.</p>{/if}
		<label>Apply to <select bind:value={scope} disabled={scopeLocked} onchange={() => {target = scope === 'category' ? 'business' : scope === 'app' ? capturedApp || reviewedDraft?.appIdentifier || '' : '';}}><option value="all">Everywhere</option><option value="app">This app</option><option value="category">App category</option></select></label>
		{#if scopeLocked}<p>This legacy confirmation is restricted to the captured app.</p>{/if}
		{#if scope === 'app'}
			{#if target || capturedApp}<p>This app: {target || capturedApp}</p><details><summary>Advanced: app identifier</summary><label>App identifier <input maxlength={storage === 'account' ? 200 : 500} bind:value={target} readonly={scopeLocked} /></label></details>
			{:else}<label>App identifier (start a recording in your app to capture it automatically) <input maxlength={storage === 'account' ? 200 : 500} bind:value={target} /></label>{/if}
		{:else if scope === 'category'}<label>Category <select bind:value={target}>{#if target && !isCategoryId(target)}<option value={target}>{categoryLabel(target)}</option>{/if}{#each APP_CATEGORIES as item}<option value={item.id}>{item.name}</option>{/each}</select></label>{/if}
		{#if scopeReason}<p>Scope recommendation: {scopeReason}</p>{/if}
		<div class="row"><button onclick={() => instructions = 'Use a casual, natural and concise style. Preserve the meaning and language. Do not add facts or emojis.'}>Casual preset</button><button onclick={() => instructions = 'Use a formal, clear and professional style. Preserve the meaning and language. Do not add facts or emojis.'}>Formal preset</button></div>
		<label>Writing and punctuation instructions <textarea rows="4" maxlength="2000" bind:value={instructions}></textarea></label>
		<p>{instructions.length}/2,000 characters · {utf8Bytes(instructions)}/8,000 UTF-8 bytes. Saved rules: at most 100 and 64,000 bytes. Active rules: at most 16,000 bytes (about 4,000 tokens). Account limits are also checked by the server.</p>
		<button disabled={busy || !instructions.trim()} onclick={() => run(saveWritingRule)}>Save {editingId ? 'profile changes' : 'writing rule'}</button>
		<h4>Extract a style from your writing</h4>
		<p>Use up to five examples. Extraction sends them to your selected LLM provider. Examples stay in this view until extraction or navigation; they are never saved in the profile.</p>
		{#if capturedApp}<p>App context: {capturedApp} {appCategoryFor(settings.value['voiceInput.appCategories'], capturedApp) ? `· ${categoryLabel(appCategoryFor(settings.value['voiceInput.appCategories'], capturedApp)!)}` : ''}</p>{/if}
		<details><summary>Advanced: choose app context</summary><label>App identifier (optional) <input maxlength="200" bind:value={currentApp} /></label></details>
		{#each samples as _, index}
			<label>Writing example {index + 1} <textarea rows="4" maxlength="12000" bind:value={samples[index]}></textarea></label>
			{#if samples.length > 1}<button onclick={() => samples = samples.filter((_, i) => i !== index)}>Remove example {index + 1}</button>{/if}
		{/each}
		<p>{samples.length}/5 examples · {sampleCharacters}/12,000 total characters.</p>
		<div class="row"><button disabled={samples.length >= 5 || busy} onclick={() => samples = [...samples, '']}>Add example</button><button disabled={busy || samples.some(sample => !sample.trim()) || sampleCharacters > 12000} onclick={() => run(extractStyle)}>Extract my style</button></div>
		<h4>Account writing rules</h4>
		<p>These rules belong to your account and apply only when writing preferences are enabled.</p>
		<button disabled={busy} onclick={() => run(async () => {await loadRules();})}>Load saved rules</button>
		{#each rules as rule (rule.id)}
			<div class="rule"><p>Applies to: {savedRuleScopeLabel(rule.apps)}</p><label>Rule name <input maxlength="100" bind:value={rule.name} /></label><label>Writing rule <textarea maxlength="2000" bind:value={rule.rule_text}></textarea></label><div class="row"><button disabled={busy} onclick={() => run(() => updateAccountRule(rule))}>Save changes</button><button disabled={busy} onclick={() => run(async () => {await request('/preferences', 'DELETE', {id: rule.id}); await loadRules();})}>Delete rule</button></div></div>
		{/each}
	</details>
	<details><summary>App category assignments</summary>
		{#each settings.value['voiceInput.appCategories'] as mapping}<div class="row"><span>{mapping.app} → {categoryLabel(mapping.category)}</span><button onclick={() => {app = mapping.app; category = isCategoryId(mapping.category) ? mapping.category : 'business';}}>Edit</button><button onclick={() => settings.value = {...settings.value, 'voiceInput.appCategories': settings.value['voiceInput.appCategories'].filter(m => m.app !== mapping.app)}}>Remove</button></div>{/each}
		<label>App identifier <input maxlength="500" bind:value={app} /></label><label>Category <select bind:value={category}>{#each APP_CATEGORIES as item}<option value={item.id}>{item.name}</option>{/each}</select></label>
		<button disabled={!app.trim()} onclick={() => run(() => {
			if (!isCategoryId(category)) throw new Error('Choose a category from the catalog.');
			const mappings = settings.value['voiceInput.appCategories'].filter(m => m.app.toLowerCase() !== app.trim().toLowerCase());
			if (mappings.length >= 100) throw new Error('At most 100 app mappings are allowed.');
			settings.value = {...settings.value, 'voiceInput.appCategories': [...mappings, {app: app.trim(), category}]}; app = ''; message = 'Category assignment saved locally.';
		})}>Assign category</button>
	</details>
	{#if message}<p role="status">{message}</p>{/if}
</section>

<style>
	.preferences {display: grid; gap: 12px; border: 1px solid #8885; border-radius: 12px; padding: 20px;}
	h3,h4 {font-weight: 600;} h4 {margin-top: 12px;} p {font-size: 0.875rem; opacity: .8;}
	label {display: grid; gap: 6px;} label:has(input[type=checkbox]) {display: flex; align-items: center;}
	input:not([type=checkbox]), textarea, select {border: 1px solid #8887; border-radius: 6px; padding: 8px; color: inherit; background: transparent; width: 100%;}
	button {border: 1px solid #8887; border-radius: 6px; padding: 7px 12px; width: fit-content;} button:disabled {opacity: .45;}
	.row {display: flex; align-items: center; gap: 10px; flex-wrap: wrap;} .rule {display: grid; gap: 8px; padding-top: 12px;}
	details[open] > :not(summary) {margin-top: 12px;} summary {cursor: pointer; font-weight: 600;}
</style>
