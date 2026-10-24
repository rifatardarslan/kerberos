import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, ErrorType, AgentError } from '../src/adapters/base-adapter.js';
import { createAdapter } from '../src/adapters/index.js';
import { ClaudeAdapter } from '../src/adapters/claude-adapter.js';
import { CodexAdapter } from '../src/adapters/codex-adapter.js';
import { AgyAdapter } from '../src/adapters/agy-adapter.js';
import { OpenCodeAdapter } from '../src/adapters/opencode-adapter.js';
import { ProcessPool } from '../src/core/process-pool.js';
import { Workspace } from '../src/core/workspace.js';
import { tmpDir, fakeAgent } from './helpers.js';

const deps = (timeoutMs = 10_000) => ({ workspace: new Workspace(tmpDir()), pool: new ProcessPool({ maxConcurrency: 2 }), timeoutMs });

test('classifyError', () => {
  assert.equal(classifyError({ stderr: 'HTTP 429 Too Many Requests' }), ErrorType.RATE_LIMIT);
  assert.equal(classifyError({ text: 'Claude AI usage limit reached' }), ErrorType.RATE_LIMIT);
  assert.equal(classifyError({ stderr: '401 Unauthorized' }), ErrorType.AUTH);
  assert.equal(classifyError({ stderr: 'boom', timedOut: true }), ErrorType.TIMEOUT);
  assert.equal(classifyError({ stderr: 'boom', exitCode: 2 }), ErrorType.CRASH);
});

test('generic adapter returns stdout text', async () => {
  const a = createAdapter('w', fakeAgent('W'), deps());
  const chunks = [];
  const res = await a.run({ prompt: 'merhaba', onChunk: (c) => chunks.push(c) });
  assert.match(res.text, /Taslak/);
  assert.ok(chunks.length > 0);
});

test('idle timeout kills the process and throws TIMEOUT', async () => {
  const d = deps(1200);
  const a = createAdapter('w', fakeAgent('W', 'hang'), d);
  const t0 = Date.now();
  await assert.rejects(a.run({ prompt: 'x' }), (e) => e instanceof AgentError && e.type === ErrorType.TIMEOUT);
  assert.ok(Date.now() - t0 < 8000);
  assert.equal(d.pool.size, 0);
});

test('rate limit is classified and not retried', async () => {
  const a = createAdapter('w', fakeAgent('W', 'ratelimit'), deps());
  let retries = 0;
  await assert.rejects(
    a.run({ prompt: 'x', onChunk: (c) => c.kind === 'system' && retries++ }),
    (e) => e.type === ErrorType.RATE_LIMIT,
  );
  assert.equal(retries, 0);
});

test('crash is retried once then thrown', async () => {
  const a = createAdapter('w', fakeAgent('W', 'crash'), deps());
  let retries = 0;
  await assert.rejects(
    a.run({ prompt: 'x', onChunk: (c) => c.kind === 'system' && retries++ }),
    (e) => e.type === ErrorType.CRASH && e.exitCode === 3,
  );
  assert.equal(retries, 1);
});

test('empty output is a failure', async () => {
  const a = createAdapter('w', { ...fakeAgent('W', 'empty') }, deps());
  a.maxRetries = 0;
  await assert.rejects(a.run({ prompt: 'x' }), /boş yanıt/);
});

test('missing binary -> NOT_FOUND', async () => {
  const a = createAdapter('w', { type: 'generic', bin: 'definitely-not-a-real-cli-xyz' }, deps());
  await assert.rejects(a.run({ prompt: 'x' }), (e) => e.type === ErrorType.NOT_FOUND);
});

test('abort signal kills the process', async () => {
  const d = deps();
  const a = createAdapter('w', fakeAgent('W', 'hang'), d);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  await assert.rejects(a.run({ prompt: 'x', signal: ac.signal }), (e) => e.type === ErrorType.ABORTED);
});

test('CLI argument mapping uses real flags', () => {
  const d = deps();
  const claude = new ClaudeAdapter('claude', { model: 'opus', effort: 'high', thinkingTokens: 8000 }, d);
  const ca = claude.buildArgs({ system: 'sys' });
  assert.ok(ca.includes('-p') && ca.includes('--effort') && ca.includes('--strict-mcp-config'));
  assert.equal(ca[ca.indexOf('--model') + 1], 'opus');
  assert.ok(!ca.includes('--max-thinking-tokens'));
  assert.deepEqual(claude.buildEnv(), { MAX_THINKING_TOKENS: '8000' });

  const codex = new CodexAdapter('codex', { model: 'gpt-x', effort: 'low' }, d);
  const xa = codex.buildArgs({ lastFile: 'f' });
  assert.equal(xa[0], 'exec');
  assert.ok(xa.includes('model_reasoning_effort="low"'));
  assert.equal(xa[xa.indexOf('-s') + 1], 'read-only');

  const oc = new OpenCodeAdapter('opencode', { model: 'anthropic/x', variant: 'high' }, d);
  assert.ok(oc.buildArgs().includes('anthropic/x#high'));

  const agy = new AgyAdapter('agy', { effort: 'max' }, d);
  const line = JSON.parse(agy.buildInput({ prompt: 'p', system: 's' }));
  assert.equal(line.event, 'user');
  assert.match(line.message.content, /s[\s\S]*p/);
});

test('stream parsers', () => {
  const d = deps();
  const claude = new ClaudeAdapter('claude', {}, d);
  const st = { sawDelta: false };
  assert.deepEqual(
    claude.parseLine('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"PO"}}}', st),
    { chunk: 'PO' },
  );
  assert.equal(claude.parseLine('{"type":"assistant","message":{"content":[{"type":"text","text":"PONG"}]}}', st), null);
  assert.deepEqual(claude.parseLine('{"type":"result","is_error":false,"result":"PONG"}', st), { final: 'PONG' });
  assert.match(claude.parseLine('{"type":"result","is_error":true,"result":"limit","api_error_status":429}', st).error, /429/);

  const codex = new CodexAdapter('codex', {}, d);
  assert.deepEqual(codex.parseLine('{"type":"item.completed","item":{"type":"agent_message","text":"PONG"}}'), { chunk: 'PONG\n' });
  assert.ok(codex.parseLine('{"type":"turn.failed","error":{"message":"rate limit"}}').error);

  const agy = new AgyAdapter('agy', {}, d);
  assert.deepEqual(agy.parseLine('{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"B"}}'), { chunk: 'B' });
  assert.deepEqual(agy.parseLine('{"event":"result","result":{"status":"SUCCESS","response":"B\\n"}}'), { final: 'B\n' });
  assert.ok(agy.parseLine('{"event":"result","result":{"status":"ERROR","error":"x"}}').error);

  const oc = new OpenCodeAdapter('opencode', {}, d);
  assert.deepEqual(oc.parseLine('{"type":"text","part":{"text":"PONG"}}'), { chunk: 'PONG\n' });
});
