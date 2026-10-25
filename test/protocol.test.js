import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, parseWith, parseFileEnvelope, ArchPlanSchema, TaskListSchema } from '../src/core/protocol.js';

test('extractJson: fenced, bare and embedded JSON', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('{"a":2}'), { a: 2 });
  assert.deepEqual(extractJson('Here you go: {"a":{"b":"x}y"}} thanks'), { a: { b: 'x}y' } });
  assert.deepEqual(extractJson('noise [1,2] more {"big":{"k":[1,2,3]}}'), { big: { k: [1, 2, 3] } });
  assert.throws(() => extractJson('no json here'));
  assert.throws(() => extractJson(''));
});

test('ArchPlanSchema fills defaults and rejects missing summary', () => {
  const plan = parseWith(ArchPlanSchema, '{"summary":"s","files_to_modify":["a.js"]}');
  assert.equal(plan.phase, 'PLAN_READY');
  assert.deepEqual(plan.risks, []);
  assert.throws(() => parseWith(ArchPlanSchema, '{"files_to_modify":[]}'), /summary/);
});

test('TaskListSchema accepts bare arrays and validates action', () => {
  const t = { target_worker: 'codex', action: 'create_file', file_path: 'a.js', instruction: 'x' };
  assert.equal(parseWith(TaskListSchema, JSON.stringify([t])).tasks[0].phase, 'CODING');
  assert.throws(() => parseWith(TaskListSchema, JSON.stringify([{ ...t, action: 'rm_rf' }])));
});

test('parseFileEnvelope handles code containing fences and multiple files', () => {
  const text = [
    'preamble',
    '=== FILE: src/a.md ===',
    '# Title',
    '```js',
    'x()',
    '```',
    '=== END FILE ===',
    '=== FILE: b.js ===',
    '```js',
    'const b = 1;',
    '```',
    '=== END FILE ===',
  ].join('\n');
  const files = parseFileEnvelope(text);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'src/a.md');
  assert.equal(files[0].content, '# Title\n```js\nx()\n```\n');
  assert.equal(files[1].content, 'const b = 1;\n'); // wrapping fence stripped
  assert.deepEqual(parseFileEnvelope('nothing'), []);
});

test('parseFileEnvelope tolerates CRLF', () => {
  const files = parseFileEnvelope('=== FILE: a.txt ===\r\nline1\r\nline2\r\n=== END FILE ===\r\n');
  assert.equal(files.length, 1);
  assert.match(files[0].content, /line1\r?\nline2/);
});

test('triage: clarify carries the questions as JSON', async () => {
  const { parseTriage } = await import('../src/core/prompts.js');
  const { ClarifySchema } = await import('../src/core/protocol.js');
  const t = parseTriage('KIND: clarify\n```json\n{"questions":[{"question":"Tema?","options":["Koyu","Açık","Sistem","Mavi","Fazla"]}]}\n```');
  assert.equal(t.kind, 'clarify');
  const { questions } = parseWith(ClarifySchema, t.text);
  assert.equal(questions[0].options.length, 4); // capped like AskUserQuestion
  assert.deepEqual(questions[0].options[0], { label: 'Koyu', description: '' });
  assert.equal(questions[0].multiSelect, false);
  assert.throws(() => parseWith(ClarifySchema, '{"questions":[{"question":"Tek?","options":["a"]}]}'));
});

test('typedAnswer picks options by number', async () => {
  const { typedAnswer } = await import('../src/core/protocol.js');
  const q = { options: [{ label: 'Koyu' }, { label: 'Açık' }, { label: 'Sistem' }] };
  assert.equal(typedAnswer(q, '2'), 'Açık');
  assert.equal(typedAnswer(q, '7'), '7');
  assert.equal(typedAnswer(q, 'mavi olsun'), 'mavi olsun');
  assert.deepEqual(typedAnswer({ ...q, multiSelect: true }, '1, 3'), ['Koyu', 'Sistem']);
});
