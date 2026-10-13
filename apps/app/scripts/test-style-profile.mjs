import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
const contract = {};
runInNewContext(ts.transpileModule(await readFile(new URL('../src/lib/services/preference-contract.ts', import.meta.url), 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText, {exports: contract, TextEncoder});
const exports = {};
runInNewContext(ts.transpileModule(await readFile(new URL('../src/lib/services/style-profile.ts', import.meta.url), 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText, {exports, require: () => contract});
const select = exports.selectStyleProfile;
const profiles = [
  {scope:'all',target:'',instructions:'general'},
  {scope:'category',target:'work',instructions:'professional'},
  {scope:'app',target:'mail.exe',instructions:'brief'},
];
test('exact app outranks explicit category and global style', () => {
  assert.equal(select(profiles,[{app:'mail.exe',category:'work'}],'MAIL.EXE').instructions,'brief');
});
test('only explicitly assigned apps inherit a category', () => {
  assert.equal(select(profiles,[{app:'editor.exe',category:'work'}],'editor.exe').instructions,'professional');
  assert.equal(select(profiles,[],'editor.exe').instructions,'general');
});
test('unconfigured profile produces no style instructions', () => {
  assert.equal(select([],[],'unknown'),undefined);
});
