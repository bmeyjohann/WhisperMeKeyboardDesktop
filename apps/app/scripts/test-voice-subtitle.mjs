import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const source = await readFile(new URL('../static/voice-subtitle.js', import.meta.url), 'utf8');
const ctx = {};
runInNewContext(source, ctx);
test('short text remains intact for the single-line viewport', () => {
  assert.equal(ctx.voiceSubtitle('Old sentence. Recent sentence. Still speaking'), 'Old sentence. Recent sentence. Still speaking');
});
test('unpunctuated long speech keeps its latest words without shrinking', () => {
  const full = `${'earlier words '.repeat(1000)}the latest words`;
  const shown = ctx.voiceSubtitle(full);
  assert.ok(shown.length <= 161);
  assert.ok(shown.endsWith('the latest words'));
  assert.ok(full.length > 1000);
});
test('empty input and whitespace', () => {
  assert.equal(ctx.voiceSubtitle(' \n '), '');
  assert.equal(ctx.voiceSubtitle('Hello\nworld'), 'Hello world');
});

test('unicode suffixes retain complete characters and descenders', () => {
  const shown = ctx.voiceSubtitle(`${'😀'.repeat(200)} g j p q y`);
  assert.ok(shown.endsWith('g j p q y'));
  assert.ok(shown.isWellFormed());
});

const html = await readFile(new URL('../static/overlay.html', import.meta.url), 'utf8');
function overlayFixture(data) {
  const elements = new Map();
  const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, {
      textContent: '', hidden: false, scrollWidth: 900, scrollLeft: 0,
      classList: { toggle() {} }, setAttribute() {},
    });
    return elements.get(id);
  } };
  const window = { __WM_VOICE: data };
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    window, document, voiceSubtitle: ctx.voiceSubtitle,
    ResizeObserver: class { observe() {} },
  });
  window.__WM_RENDER_VOICE();
  return { window, element: document.getElementById };
}

test('processing stages replace only presentation, and blank question disappears', () => {
  const data = {phase:'processing', transcript:'Spoken text', assistant:' \n ', statusText:'Gathering more context…'};
  const fixture = overlayFixture(data);
  assert.equal(fixture.element('voice-transcript').textContent, 'Gathering more context…');
  assert.equal(fixture.element('voice-assistant').textContent, '');
  assert.equal(data.transcript, 'Spoken text');
  assert.equal(fixture.element('voice-actions').hidden, true);
});

test('processing defaults to Formatting and stale stage never replaces recording speech', () => {
  const data = {phase:'processing', transcript:'Spoken text', assistant:'Which day?'};
  const fixture = overlayFixture(data);
  assert.equal(fixture.element('voice-transcript').textContent, 'Formatting…');
  assert.equal(fixture.element('voice-assistant').textContent, 'Which day?');
  data.statusText = '  ';
  fixture.window.__WM_RENDER_VOICE();
  assert.equal(fixture.element('voice-transcript').textContent, 'Formatting…');
  data.statusText = 'Gathering more context…';
  data.phase = 'recording';
  fixture.window.__WM_RENDER_VOICE();
  assert.equal(fixture.element('voice-transcript').textContent, 'Spoken text');
  assert.equal(data.transcript, 'Spoken text');
});

test('expansion is end-of-session only and preserves full content', async () => {
  const transcript = 'Speech with descenders g j p q y. '.repeat(30);
  const fixture = overlayFixture({phase:'recording', transcript});
  await fixture.element('voice-expand').onclick();
  assert.notEqual(fixture.element('voice-transcript').textContent, transcript);
  fixture.window.__WM_VOICE = {phase:'idle', transcript};
  fixture.window.__WM_RENDER_VOICE();
  await fixture.element('voice-expand').onclick();
  assert.equal(fixture.element('voice-transcript').textContent, transcript);
  assert.equal(fixture.element('voice-actions').hidden, false);
  fixture.window.__WM_VOICE.phase = 'recording';
  fixture.window.__WM_RENDER_VOICE();
  assert.notEqual(fixture.element('voice-transcript').textContent, transcript);
});
