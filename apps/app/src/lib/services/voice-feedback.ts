import { writable } from 'svelte/store';

export type BudgetStatus = {warning: boolean; committedUsd: number; limitUsd: number; resetsAt: string};
export type VoiceFailure = { code: string; stage: string; provider?: string; retryable: boolean; retryAfterMs?: number; budget?: BudgetStatus };
export const voiceFeedback = writable<{connection: string; retry: string; budget?: string}>({ connection: '', retry: '' });

export function budgetWarningText(budget?: BudgetStatus) {
	if (!budget?.warning || !Number.isFinite(budget.committedUsd) || !Number.isFinite(budget.limitUsd) || !Number.isFinite(Date.parse(budget.resetsAt))) return '';
	return `Cerebras monthly budget: $${budget.committedUsd.toFixed(2)} of $${budget.limitUsd.toFixed(2)} used or reserved. Resets ${budget.resetsAt.slice(0, 10)} (UTC).`;
}
const budgetStorageKey = 'whisperme-budget-notice';
function savedBudgetWarning() {
	try {
		const saved = JSON.parse(localStorage.getItem(budgetStorageKey) || 'null') as BudgetStatus | null;
		return saved && Date.parse(saved.resetsAt) > Date.now() ? budgetWarningText(saved) : '';
	} catch { return ''; }
}
export const voiceBudgetWarning = writable(savedBudgetWarning());
/** Persist only the four public budget fields, never the surrounding response. */
export function reportBudgetStatus(budget?: BudgetStatus) {
	if (!budget) return '';
	const text = budgetWarningText(budget);
	voiceBudgetWarning.set(text);
	voiceFeedback.update(value => ({...value, budget: text}));
	try {
		if (text) localStorage.setItem(budgetStorageKey, JSON.stringify({warning: true, committedUsd: budget.committedUsd, limitUsd: budget.limitUsd, resetsAt: budget.resetsAt}));
		else localStorage.removeItem(budgetStorageKey);
	} catch { /* Session history still retains the warning when storage is unavailable. */ }
	return text;
}

// A missing acknowledgement measures the service path, not the user's internet.
export function connectionText(rttMs?: number, missed = 0, offline = false) {
	if (offline) return 'Internet unavailable (device reports offline).';
	if (missed > 0) return `Connection to WhisperMe interrupted or slow · ${missed} missing heartbeat${missed === 1 ? '' : 's'} · cause unknown`;
	if (rttMs === undefined) return 'Checking connection to WhisperMe…';
	return `Connection to WhisperMe ${rttMs >= 1000 ? 'slow' : 'responding'} · ${Math.round(rttMs)} ms round trip`;
}

export function providerRetryText(event: {text?: string; stage?: string; attempt?: number; maxAttempts?: number}) {
	return event.text?.trim() || `Retrying ${event.stage === 'transcription' ? 'transcription' : 'text processing'} · attempt ${event.attempt ?? 2} of ${Math.min(event.maxAttempts ?? 3, 3)}`;
}
