import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, ErrorType, AgentError } from '../src/adapters/base-adapter.js';
import { createAdapter, GenericAdapter } from '../src/adapters/index.js';
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

test('parsers report the resolved model, token usage and plan quota', () => {
  const d = deps();
  const claude = new ClaudeAdapter('claude', {}, d);
  assert.deepEqual(claude.parseLine('{"type":"system","subtype":"init","model":"claude-opus-5-5"}', {}), { model: 'claude-opus-5-5' });
  const rl = claude.parseLine(
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.53,"resetsAt":1792891200},"seven_day":{"utilization":0.31,"resetsAt":1792990800}}}}',
    {},
  ).rateLimit;
  assert.deepEqual(
    rl.windows.map((w) => [w.id, w.used]),
    [
      ['five_hour', 0.53],
      ['seven_day', 0.31],
    ],
  );
  const res = claude.parseLine('{"type":"result","result":"ok","usage":{"input_tokens":2,"cache_read_input_tokens":10,"output_tokens":4},"total_cost_usd":0.01}', {});
  assert.deepEqual(res.usage, { input: 12, output: 4, cached: 10, cost: 0.01 });

  const codex = new CodexAdapter('codex', {}, d);
  assert.deepEqual(codex.parseLine('{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":5,"reasoning_output_tokens":3}}').usage, {
    input: 100,
    output: 8,
    cached: 40,
  });

  const agy = new AgyAdapter('agy', {}, d);
  assert.equal(agy.parseLine('{"event":"result","result":{"status":"SUCCESS","response":"x","usage":{"input_tokens":7,"output_tokens":2,"thinking_tokens":1}}}').usage.output, 3);
});

test('agy: plan mode stays effective and workspace writes are stopped', () => {
  const agy = new AgyAdapter('agy', {}, deps());
  // --disable-slash-commands makes agy ignore --mode plan and write files (seen with agy, Oct 2026).
  assert.ok(!agy.buildArgs({}).includes('--disable-slash-commands'));
  assert.ok(agy.buildArgs({}).includes('plan'));
  const step = (name, params) => JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool', state: 'ACTIVE', tool_name: name, tool_info: { name, parameters: params } } });
  const win = (...parts) => parts.join('\\');
  assert.match(agy.parseLine(step('write_file', { Path: win('C:', 'proj', 'hello.txt') })).violation, /write_file/);
  assert.match(agy.parseLine(step('run_command', { CommandLine: 'del x' })).violation, /run_command/);
  assert.equal(agy.parseLine(step('write_file', { Path: win('C:', 'Users', 'a', '.gemini', 'antigravity-cli', 'brain', 'abc', 'implementation_plan.md') })).violation, undefined);
  assert.equal(agy.parseLine(step('view_file', { Path: win('C:', 'proj', 'a.js') })).violation, undefined);
});

test('a policy violation kills the run and is not retried', async () => {
  class Guarded extends GenericAdapter {
    parseLine(line) {
      return line.startsWith('WRITE') ? { violation: line } : { chunk: line };
    }
  }
  const a = new Guarded('x', fakeAgent('X', 'violation'), deps());
  let calls = 0;
  const orig = a.run.bind(a);
  await assert.rejects(orig({ prompt: 'p', onChunk: () => calls++ }), (e) => e.type === ErrorType.POLICY && /WRITE hello/.test(e.message));
  assert.equal(calls, 0); // not retried like a crash
});
