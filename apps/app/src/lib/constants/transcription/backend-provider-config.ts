export const VOICE_INPUT_TRANSCRIPTION_PROVIDER_VALUES = [
	'groq_batch',
	'voxtral_realtime',
	'muse_realtime',
] as const;

export type VoiceInputTranscriptionProvider =
	(typeof VOICE_INPUT_TRANSCRIPTION_PROVIDER_VALUES)[number];

export const VOICE_INPUT_LLM_PROVIDER_VALUES = [
	'groq_kimi_k2',
	'cerebras_glm_4_7',
] as const;

export type VoiceInputLlmProvider =
	(typeof VOICE_INPUT_LLM_PROVIDER_VALUES)[number];

export const VOICE_LLM_MODELS = {
	groq_kimi_k2: [
		{ value: 'qwen/qwen3.8-27b', label: 'Qwen 3.8 27B (recommended)' },
		{ value: 'qwen/qwen3.6-27b', label: 'Qwen 3.6 27B' },
		{ value: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' },
		{ value: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B' },
	],
	cerebras_glm_4_7: [
		{ value: 'gemma-4-31b', label: 'Gemma 4 31B (recommended)' },
		{ value: 'qwen-3.8-27b', label: 'Qwen 3.8 27B' },
		{ value: 'gpt-oss-120b', label: 'GPT-OSS 120B' },
	],
} satisfies Record<VoiceInputLlmProvider, { value: string; label: string }[]>;

export function compatibleLlmModel(
	provider: VoiceInputLlmProvider,
	model: string,
) {
	const models = VOICE_LLM_MODELS[provider];
	return models.some((item) => item.value === model) ? model : models[0].value;
}

/** Missing routing on older settings migrates to server defaults; overrides remain saved. */
export const REASONING_EFFORTS = ['default', 'none', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];
export function reasoningChoices(model?: string) {
	return REASONING_EFFORTS.filter(value => value !== 'none' || !/gpt-oss/i.test(model || ''));
}
export function compatibleReasoningEffort(model: string | undefined, effort: unknown): ReasoningEffort {
	return reasoningChoices(model).includes(effort as ReasoningEffort) ? effort as ReasoningEffort : 'default';
}
export function llmRoutingOptions(routing: 'server' | 'explicit' | undefined, provider: VoiceInputLlmProvider, model: string, effort: unknown = 'default') {
	const selectedModel = routing === 'explicit' ? compatibleLlmModel(provider, model) : undefined;
	const reasoningEffort = compatibleReasoningEffort(selectedModel, effort);
	return {
		...(routing !== 'explicit'
			? { llmRouting: 'server' as const, llmProvider: 'default' as const }
			: { llmRouting: 'explicit' as const, llmProvider: provider, llmModel: selectedModel! }),
		...(reasoningEffort === 'default' ? {} : {reasoningEffort}),
	};
}

export const VOICE_INPUT_TRANSCRIPTION_PROVIDER_OPTIONS = [
	{
		value: 'muse_realtime',
		label: 'Meta Muse Realtime',
		description: 'Live Muse transcription',
	},
	{
		value: 'groq_batch',
		label: 'Groq Batch',
		description: 'Record first, then upload audio in one request.',
	},
	{
		value: 'voxtral_realtime',
		label: 'Voxtral Realtime',
		description: 'Stream chunks to /realtime while recording.',
	},
] as const satisfies {
	value: VoiceInputTranscriptionProvider;
	label: string;
	description: string;
}[];

export const VOICE_INPUT_LLM_PROVIDER_OPTIONS = [
	{
		value: 'groq_kimi_k2',
		label: 'Groq',
		description: 'Fast Groq-hosted text generation.',
	},
	{
		value: 'cerebras_glm_4_7',
		label: 'Cerebras',
		description: 'Choose Gemma, Qwen or another available model.',
	},
] as const satisfies {
	value: VoiceInputLlmProvider;
	label: string;
	description: string;
}[];
