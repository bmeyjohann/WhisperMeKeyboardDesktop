/** Keep the original editor snapshot local; the model receives one bounded window. */
export const DEFAULT_CONTEXT_SIDE = 2_000;
export const MAX_CONTEXT_SIDE = 12_000;
export const MAX_SELECTION = 8_000;
export const MAX_LOCAL_FIELD = 1_000_000;

export type EditorSnapshot = {
	fullText: string;
	textBeforeCursor: string;
	selectedText: string;
	textAfterCursor: string;
	packageName: string;
	identity: string;
	fieldType?: string;
	fieldName?: string;
	fieldRole?: string;
	fieldLabel?: string;
	fieldHint?: string;
	appName?: string;
	windowTitle?: string;
	isMultiline?: boolean;
	isRichEditor?: boolean;
	relatedFields?: {
		fieldRole: 'email_subject' | 'email_body';
		fieldLabel: string;
		text: string;
		truncated: boolean;
	}[];
};

export type ContextWindow = {
	start: number;
	totalLength: number;
	hasBefore: boolean;
	hasAfter: boolean;
};

export type EditorWindow = {
	start: number;
	end: number;
	context: Omit<EditorSnapshot, 'identity'> & {
		cursorPosition: number;
		contextWindow: ContextWindow;
	};
};

function splitsSurrogate(text: string, offset: number) {
	return (
		offset > 0 &&
		offset < text.length &&
		text.charCodeAt(offset - 1) >= 0xd800 &&
		text.charCodeAt(offset - 1) <= 0xdbff &&
		text.charCodeAt(offset) >= 0xdc00 &&
		text.charCodeAt(offset) <= 0xdfff
	);
}

export function createEditorWindow(
	snapshot: EditorSnapshot,
	beforeChars = DEFAULT_CONTEXT_SIDE,
	afterChars = DEFAULT_CONTEXT_SIDE,
): EditorWindow {
	for (const budget of [beforeChars, afterChars]) {
		if (!Number.isInteger(budget) || budget < 0 || budget > MAX_CONTEXT_SIDE)
			throw new Error('The requested context exceeds the supported window.');
	}
	const { fullText, textBeforeCursor, selectedText, textAfterCursor } =
		snapshot;
	if (
		[fullText, textBeforeCursor, selectedText, textAfterCursor].some(
			(value) => typeof value !== 'string',
		) ||
		textBeforeCursor + selectedText + textAfterCursor !== fullText
	)
		throw new Error(
			'The editor snapshot is inconsistent. Capture the field again.',
		);
	if (fullText.length > MAX_LOCAL_FIELD)
		throw new Error('This field exceeds the safe local editing limit.');
	if (selectedText.length > MAX_SELECTION)
		throw new Error('Select a smaller passage before using voice editing.');
	const selectionStart = textBeforeCursor.length;
	const selectionEnd = selectionStart + selectedText.length;
	if (
		splitsSurrogate(fullText, selectionStart) ||
		splitsSurrogate(fullText, selectionEnd)
	)
		throw new Error(
			'The editor selection splits a character. Move the caret and retry.',
		);
	let start = Math.max(0, selectionStart - beforeChars);
	let end = Math.min(fullText.length, selectionEnd + afterChars);
	if (splitsSurrogate(fullText, start)) start--;
	if (splitsSurrogate(fullText, end)) end++;
	const before = fullText.slice(start, selectionStart);
	const after = fullText.slice(selectionEnd, end);
	const context: EditorWindow['context'] = {
		fullText: before + selectedText + after,
		textBeforeCursor: before,
		selectedText,
		textAfterCursor: after,
		cursorPosition: before.length,
		packageName: snapshot.packageName,
		contextWindow: {
			start,
			totalLength: fullText.length,
			hasBefore: start > 0,
			hasAfter: end < fullText.length,
		},
	};
	// Explicit allowlist: native identity, timing data and the rest of the document
	// must not leak into the provider request through an object spread.
	for (const key of [
		'fieldType',
		'fieldName',
		'fieldRole',
		'fieldLabel',
		'fieldHint',
		'appName',
		'windowTitle',
	] as const) {
		if (typeof snapshot[key] === 'string')
			context[key] = snapshot[key].slice(0, 256);
	}
	for (const key of ['isMultiline', 'isRichEditor'] as const) {
		if (typeof snapshot[key] === 'boolean') context[key] = snapshot[key];
	}
	// Only a verified subject/body counterpart, never a generic screen scrape.
	if (
		Array.isArray(snapshot.relatedFields) &&
		(snapshot.fieldRole === 'email_subject' ||
			snapshot.fieldRole === 'email_body')
	) {
		context.relatedFields = snapshot.relatedFields
			.filter(
				(field) =>
					field &&
					(field.fieldRole === 'email_subject' ||
						field.fieldRole === 'email_body') &&
					field.fieldRole !== snapshot.fieldRole &&
					typeof field.text === 'string',
			)
			.slice(0, 1)
			.map((field) => {
				const limit = field.fieldRole === 'email_subject' ? 512 : 2048;
				let length = Math.min(field.text.length, limit);
				if (splitsSurrogate(field.text, length)) length--;
				return {
					fieldRole: field.fieldRole,
					fieldLabel:
						typeof field.fieldLabel === 'string'
							? field.fieldLabel.slice(0, 256)
							: '',
					text: field.text.slice(0, length),
					truncated: field.truncated === true || length < field.text.length,
				};
			});
	}
	return { start, end, context };
}

function inferredCaret(
	original: string,
	result: string,
	originalCaret: number,
) {
	if (original === result) return originalCaret;
	let prefix = 0;
	while (
		prefix < originalCaret &&
		prefix < original.length &&
		prefix < result.length &&
		original[prefix] === result[prefix]
	)
		prefix++;
	let suffix = 0;
	while (
		suffix < original.length - prefix &&
		suffix < result.length - prefix &&
		original[original.length - suffix - 1] ===
			result[result.length - suffix - 1]
	)
		suffix++;
	return result.length - suffix;
}

export function applyEditorWindow(
	snapshot: EditorSnapshot,
	window: EditorWindow,
	result: string,
	cursorPosition?: number,
): { text: string; cursorPosition: number } {
	if (
		window.context.contextWindow.totalLength !== snapshot.fullText.length ||
		snapshot.fullText.slice(window.start, window.end) !==
			window.context.fullText
	)
		throw new Error(
			'The local editing window changed. Capture the field again.',
		);
	if (typeof result !== 'string' || result.length > 100_000)
		throw new Error('The editing result is too large to apply safely.');
	const caret =
		cursorPosition ??
		inferredCaret(
			window.context.fullText,
			result,
			window.context.cursorPosition,
		);
	if (
		!Number.isInteger(caret) ||
		caret < 0 ||
		caret > result.length ||
		splitsSurrogate(result, caret)
	)
		throw new Error('The editing result contains an invalid cursor position.');
	const text =
		snapshot.fullText.slice(0, window.start) +
		result +
		snapshot.fullText.slice(window.end);
	if (text.length > MAX_LOCAL_FIELD)
		throw new Error(
			'The resulting field exceeds the safe local editing limit.',
		);
	return { text, cursorPosition: window.start + caret };
}
