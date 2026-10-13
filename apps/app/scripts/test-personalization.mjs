import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
async function load(name, modules = {}, globals = {}) {
	const exports = {};
	runInNewContext(ts.transpileModule(await readFile(new URL(`../src/lib/services/${name}.ts`, import.meta.url), 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText, {exports, TextEncoder, require: key => modules[key], ...globals});
	return exports;
}
const api = await load('preference-contract');
const style = await load('style-profile', {'./preference-contract': api});
const plain = value => JSON.parse(JSON.stringify(value));
test('canonical category wire IDs preserve legacy local profile selection', () => {
	assert.deepEqual(plain(api.APP_CATEGORIES.map(row => row.id)), ['personal','business','development','writing','productivity','education','other']);
	const mappings = [{app:'EDITOR.EXE', category:'old work'}];
	assert.equal(api.appCategoryFor(mappings, 'editor.exe'), undefined);
	assert.equal(style.selectStyleProfile([{scope:'category',target:'old work',instructions:'Legacy style'}], mappings, 'editor.exe').instructions, 'Legacy style');
	assert.equal(api.appCategoryFor([{app:'EDITOR.EXE',category:'business'}], 'editor.exe'), 'business');
});
test('dictionary enforces count, per-entry characters, and actual UTF-8 bytes', () => {
	assert.deepEqual(plain(api.deduplicateDictionary(['Word', 'word', ' WORD ', 'Other'])), ['Word', 'Other']);
	assert.doesNotThrow(() => api.validateDictionary(Array(100).fill('word')));
	assert.throws(() => api.validateDictionary(Array(101).fill('word')), /100/);
	assert.throws(() => api.validateDictionary(['x'.repeat(81)]), /80/);
	assert.throws(() => api.validateDictionary(['two\nlines']), /control/);
	const words = [...Array(25).fill('é'.repeat(80)), 'é'.repeat(48)];
	assert.equal(api.utf8Bytes(words.join('')), 4096);
	assert.doesNotThrow(() => api.validateDictionary(words));
	assert.throws(() => api.validateDictionary([...words, 'é']), /4,096/);
});
test('saved and active budgets reject overflow instead of clipping rules', () => {
	assert.doesNotThrow(() => api.validateRule('x'.repeat(2000)));
	assert.throws(() => api.validateRule('x'.repeat(2001)), /2,000/);
	const rule = '漢'.repeat(2000);
	assert.doesNotThrow(() => api.validateRuleBudget([...Array(10).fill(rule), 'x'.repeat(2000), 'x'.repeat(2000)]));
	assert.throws(() => api.validateRuleBudget([...Array(10).fill(rule), 'x'.repeat(2000), 'x'.repeat(2000), 'x']), /64,000/);
	assert.throws(() => api.validateRuleBudget(Array(101).fill('x')), /100/);
	assert.doesNotThrow(() => api.validateRuleBudget(Array(8).fill('x'.repeat(2000)), true));
	assert.throws(() => api.validateRuleBudget(Array(9).fill('x'.repeat(2000)), true), /16,000/);
});
test('multi-example extraction validates exact total and nonempty samples', () => {
	assert.doesNotThrow(() => api.validateSamples(['a'.repeat(6000), 'b'.repeat(6000)]));
	assert.throws(() => api.validateSamples(['a'.repeat(12001)]), /12,000/);
	assert.throws(() => api.validateSamples(Array(6).fill('a')), /1–5/);
	assert.throws(() => api.validateSamples(['a', '  ']), /nonempty/);
});
test('scope validation rejects invented targets, locks legacy confirmations, permits scoped controls', () => {
	const base = {kind:'preference',text:'Use short sentences',scope:'app',appIdentifier:'editor.exe'};
	assert.equal(api.parsePreferenceSuggestion({...base,appIdentifier:'other.exe'}, 'editor.exe'), undefined);
	assert.equal(api.parsePreferenceSuggestion({...base,scope:'category',appIdentifier:undefined,categoryId:'invented'}, 'editor.exe'), undefined);
	assert.equal(api.parsePreferenceSuggestion({...base,scope:'all',appIdentifier:undefined,requiresConfirmation:true}, 'editor.exe'), undefined);
	const scoped = api.parsePreferenceSuggestion({...base,scope:'category',appIdentifier:undefined,categoryId:'education',requiresConfirmation:true,scopeLocked:false}, 'editor.exe');
	assert.equal(scoped.categoryId, 'education'); assert.equal(scoped.scopeLocked, false);
	assert.equal(api.parsePreferenceSuggestion({kind:'preference',text:'Use short sentences'}, 'editor.exe').scope, 'app');
	assert.equal(api.parsePreferenceSuggestion({kind:'dictionary',text:'MEYJOHANN'}, 'editor.exe').scope, 'all');
	assert.equal(api.isNoticeOnlyResponse({preferenceSuggestion:{...base,requiresConfirmation:true},finalText:'Unexpected replacement'}), true);
	assert.equal(api.isNoticeOnlyResponse({preferenceSuggestion:base}), false);
	assert.equal(api.isNoticeOnlyResponse({preferenceSuggestion:{...base,requiresConfirmation:false}}), false);
});
test('response drafts persist locally, deduplicate, remain unsaved and never enable opt-ins', async () => {
	const settings = {value:{'voiceInput.preferenceDrafts':[], 'voiceInput.usePreferences':false, 'voiceInput.useDictionary':false}};
	const drafts = await load('preference-drafts', {'./preference-contract':api, '$lib/stores/settings.svelte':{settings}}, {crypto:{randomUUID: () => 'draft'}});
	const response = {preferenceSuggestion:{kind:'dictionary',text:'MEYJOHANN',requiresConfirmation:true}};
	assert.equal(drafts.receivePreferenceSuggestions(response, 'editor.exe', false), 0);
	assert.equal(drafts.receivePreferenceSuggestions(response, 'editor.exe', true), 1);
	assert.equal(drafts.receivePreferenceSuggestions(response, 'editor.exe', true), 0);
	assert.equal(settings.value['voiceInput.preferenceDrafts'][0].kind, 'dictionary');
	assert.equal(settings.value['voiceInput.usePreferences'], false); assert.equal(settings.value['voiceInput.useDictionary'], false);
});
test('wire options keep dictionary and suggestions independently opt-in', () => {
	const settings = {'voiceInput.dictionary':['MEYJOHANN'], 'voiceInput.appCategories':[{app:'editor.exe',category:'business'}]};
	assert.deepEqual(plain(api.personalizationOptions(settings, 'editor.exe')), {dictionary:[],suggestPreferences:false,appCategory:'business'});
	assert.deepEqual(plain(api.personalizationOptions({...settings,'voiceInput.useDictionary':true,'voiceInput.suggestPreferences':true}, 'editor.exe')), {dictionary:['MEYJOHANN'],suggestPreferences:true,appCategory:'business'});
});
test('readable account scopes support legacy namespace and modern scope response', () => {
	assert.equal(api.savedRuleScopeLabel([{app_identifier:'category:business',app_platform:'*'}]), 'Business/work');
	assert.equal(api.savedRuleScopeLabel([{scope:'category',categoryId:'education',app_platform:'*'}]), 'Study/learning');
	assert.equal(api.savedRuleScopeLabel([{app_identifier:'*',app_platform:'*'}]), 'All apps');
});
