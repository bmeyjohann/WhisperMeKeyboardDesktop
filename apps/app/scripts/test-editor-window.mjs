import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';

const api = {};
runInNewContext(
	ts.transpileModule(
		await readFile(
			new URL('../src/lib/services/editor-window.ts', import.meta.url),
			'utf8',
		),
		{
			compilerOptions: {
				module: ts.ModuleKind.CommonJS,
				target: ts.ScriptTarget.ES2022,
			},
		},
	).outputText,
	{ exports: api },
);
function snapshot(before, selected = '', after = '') {
	return {
		fullText: before + selected + after,
		textBeforeCursor: before,
		selectedText: selected,
		textAfterCursor: after,
		identity: 'private-native-id',
		packageName: 'fixture',
	};
}
test('long field stays local and expanded edits preserve both distant ends', () => {
	const s = snapshot('A'.repeat(20000), 'word', 'Z'.repeat(20000));
	const w = api.createEditorWindow(s);
	assert.equal(w.context.fullText.length, 4004);
	assert.equal(w.context.identity, undefined);
	assert.equal(w.context.contextWindow.hasBefore, true);
	const expanded = api.createEditorWindow(s, 6000, 6000);
	const result = api.applyEditorWindow(
		s,
		expanded,
		`${'A'.repeat(6000)}new word${'Z'.repeat(6000)}`,
		6008,
	);
	assert.equal(result.text, `${'A'.repeat(20000)}new word${'Z'.repeat(20000)}`);
	assert.equal(result.cursorPosition, 20008);
});
test('legacy result caret follows changed text, including inserted boundary spacing', () => {
	const s = snapshot('Hello.', '', ' Existing suffix');
	const result = api.applyEditorWindow(
		s,
		api.createEditorWindow(s),
		'Hello. More. Existing suffix',
	);
	assert.equal(result.cursorPosition, 'Hello. More.'.length);
});
test('window boundaries preserve emoji and reject split selections/carets', () => {
	const s = snapshot('a😀', '', '😀b');
	const w = api.createEditorWindow(s, 1, 1);
	assert.equal(w.context.fullText, '😀😀');
	assert.throws(() => api.applyEditorWindow(s, w, '😀', 1), /cursor/);
	assert.throws(
		() => api.createEditorWindow(snapshot('\ud83d', '', '\ude00')),
		/splits/,
	);
});
test('only a bounded opposite email field is sent as read-only context', () => {
	const s = {
		...snapshot('Subject'),
		fieldRole: 'email_subject',
		relatedFields: [
			{ fieldRole: 'password', text: 'must not send' },
			{
				fieldRole: 'email_body',
				fieldLabel: 'Message body',
				text: `${'a'.repeat(2047)}😀rest`,
				truncated: false,
			},
			{ fieldRole: 'email_body', text: 'must not send a second field' },
		],
	};
	const w = api.createEditorWindow(s);
	assert.equal(w.context.relatedFields.length, 1);
	assert.equal(w.context.relatedFields[0].text.length, 2047);
	assert.equal(w.context.relatedFields[0].truncated, true);
	assert.equal(
		api.createEditorWindow({ ...s, fieldRole: 'unknown' }).context
			.relatedFields,
		undefined,
	);
});

test('oversized selections and invalid budgets fail before sending context', () => {
	assert.throws(
		() => api.createEditorWindow(snapshot('', 'x'.repeat(8001))),
		/smaller/,
	);
	assert.throws(
		() => api.createEditorWindow(snapshot('a'), 12001, 0),
		/window/,
	);
	assert.throws(
		() => api.createEditorWindow(snapshot('a'), Number.NaN, 0),
		/window/,
	);
});
