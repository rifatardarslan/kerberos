import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ModelCatalog, codexLimits, describeEffort, describeModel, parseAgyModels, parseOpencodeModels, parseTomlTop, readCliDefaults } from '../src/core/models.js';
import { tmpDir } from './helpers.js';

test('parses codex config.toml top-level keys only', () => {
  const t = parseTomlTop('model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n[tui]\nmodel = "nope"\n');
  assert.deepEqual(t, { model: 'gpt-6.1-sol', model_reasoning_effort: 'high' });
});

test('parses `agy models` and `opencode models` output', () => {
  assert.deepEqual(parseAgyModels('Fetching available models...\ngemini-4-argon-medium\tGemini 4 Argon (Medium)\nclaude-opus-5-5-high\tClaude Opus 5.5 (High)\n'), [
    { id: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
    { id: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
  ]);
  assert.deepEqual(
    parseOpencodeModels('opencode/big-pickle\nnoise line\nanthropic/claude-sonnet-5-5\n').map((m) => m.id),
    ['opencode/big-pickle', 'anthropic/claude-sonnet-5-5'],
  );
});

test('reads each CLI default from its own settings', async () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } }));
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n');
  const d = await readCliDefaults({ home });
  assert.equal(d.claude.model, 'opus');
  assert.deepEqual(d.codex, { model: 'gpt-6.1-sol', effort: 'high' });
  assert.equal(d.opencode.model, null);
});

test('describeModel says what "default" actually is', () => {
  const home = tmpDir();
  const c = new ModelCatalog({ cacheFile: path.join(home, 'models.json'), home });
  c.defaults = { claude: { model: 'opus', effortByModel: { 'claude-opus-5-5': 'high' } }, codex: { model: 'gpt-6.1-sol', effort: 'high' } };
  assert.equal(describeModel('codex', {}, c), 'CLI default · gpt-6.1-sol');
  assert.equal(describeEffort('codex', {}, c), 'CLI default · high');
  assert.equal(describeModel('claude', {}, c), 'CLI default · opus');
  c.rememberAlias('claude', 'opus', 'claude-opus-5-5');
  assert.equal(describeModel('claude', {}, c), 'CLI default · opus → claude-opus-5-5');
  assert.equal(describeEffort('claude', {}, c), 'CLI default · high');
  assert.equal(describeModel('claude', { model: 'sonnet', resolvedModel: 'claude-sonnet-5-5' }, c), 'sonnet → claude-sonnet-5-5');
  assert.equal(describeEffort('claude', { effort: 'max' }, c), 'max');
  // aliases survive restarts through the cache file
  assert.equal(new ModelCatalog({ cacheFile: path.join(home, 'models.json'), home }).resolveAlias('claude', 'opus'), 'claude-opus-5-5');
});

test('codex rate limits map to quota windows', () => {
  const l = codexLimits({ rateLimits: { planType: 'plus', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1 }, secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 2 } } });
  assert.equal(l.plan, 'plus');
  assert.deepEqual(
    l.windows.map((w) => [w.label, w.used]),
    [
      ['5-hour session', 0.12],
      ['Weekly', 0.03],
    ],
  );
});
