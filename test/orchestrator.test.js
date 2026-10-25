import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Orchestrator } from '../src/core/orchestrator.js';
import { StateMachine, Status } from '../src/core/state-machine.js';
import { ProcessPool } from '../src/core/process-pool.js';
import { Workspace } from '../src/core/workspace.js';
import { createAdapters } from '../src/adapters/index.js';
import { DEFAULT_CONFIG } from '../src/config/config.js';
import { tmpDir, fakeAgent } from './helpers.js';

function setup(agents, { chief = 'c1', fallbackChief = 'w1', workers = ['w1', 'w2'] } = {}) {
  const config = { ...structuredClone(DEFAULT_CONFIG), chief, fallbackChief, workers, agents, timeoutMs: 5000, agentCooldownMs: 60_000 };
  const workspace = new Workspace(tmpDir(), { denyWrite: config.workspace.denyWrite });
  const pool = new ProcessPool({ maxConcurrency: 3 });
  const adapters = createAdapters(config, { workspace, pool });
  const sm = new StateMachine({ chief, workers: [...workers] });
  const orch = new Orchestrator({ config, workspace, pool, adapters, sm });
  return { config, workspace, sm, orch };
}

function waitFor(sm, status, timeout = 20_000) {
  return new Promise((resolve, reject) => {
    if (sm.status === status) return resolve(sm.snapshot());
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${status}, at ${sm.status} (${sm.error})`)), timeout);
    sm.on('state', function on(s) {
      if (s.status === status) {
        clearTimeout(t);
        sm.off('state', on);
        resolve(s);
      } else if (s.status === Status.ERROR && status !== Status.ERROR) {
        clearTimeout(t);
        sm.off('state', on);
        reject(new Error(`ERROR: ${s.error}`));
      }
    });
  });
}

test('triage: small talk is answered by the chief alone', async () => {
  const { sm, orch } = setup({ c1: fakeAgent('Chief'), w1: fakeAgent('W1'), w2: fakeAgent('W2') });
  const called = new Set();
  sm.on('chunk', (c) => c.kind === 'start' && called.add(c.agent));
  const kinds = [];
  sm.on('triage', ({ kind }) => kinds.push(kind));

  assert.ok(orch.submit('selam').ok);
  await new Promise((resolve) => sm.on('state', (s, m) => m.action === 'answer' && resolve()));
  assert.equal(sm.status, Status.IDLE);
  assert.equal(sm.answer, 'Merhaba! Ne yapalım?');
  assert.deepEqual(kinds, ['chat']);
  assert.deepEqual([...called], ['c1']); // workers spent nothing
});

test('triage: a question is answered by every agent and reconciled by the chief', async () => {
  const { sm, orch } = setup({ c1: fakeAgent('Chief'), w1: fakeAgent('W1'), w2: fakeAgent('W2') });
  const steps = [];
  sm.on('chunk', (c) => c.kind === 'start' && steps.push(`${c.agent}:${c.step}`));

  assert.ok(orch.submit("y' = y, y(0) = 1 ise y(1) kaç?").ok);
  await new Promise((resolve) => sm.on('state', (s, m) => m.action === 'answer' && resolve()));
  assert.equal(sm.kind, 'question');
  assert.equal(sm.answer, 'Sonuç: 42 (ekip hemfikir)');
  assert.equal(sm.answeredBy, 3);
  assert.deepEqual(steps.sort(), ['c1:final', 'c1:triage', 'w1:answer', 'w2:answer']);
  assert.equal(sm.plan, null); // no plan, nothing to approve
});

test('/plan skips triage and always plans code', async () => {
  const { sm, orch } = setup({ c1: fakeAgent('Chief'), w1: fakeAgent('W1'), w2: fakeAgent('W2') });
  const steps = [];
  sm.on('chunk', (c) => c.kind === 'start' && c.agent === 'c1' && steps.push(c.step));
  assert.ok(orch.submit('selam', 'tui', { kind: 'task' }).ok);
  await waitFor(sm, Status.AWAITING_APPROVAL);
  assert.equal(steps[0], 'draft');
});

test('full plan -> approve -> code -> rollback flow', async () => {
  const { sm, orch, workspace } = setup({ c1: fakeAgent('Chief'), w1: fakeAgent('W1'), w2: fakeAgent('W2') });
  const debaters = new Set();
  sm.on('chunk', (c) => c.kind === 'start' && debaters.add(c.agent));

  assert.ok(orch.submit('hello.js yaz').ok);
  const planned = await waitFor(sm, Status.AWAITING_APPROVAL);
  assert.equal(planned.plan.summary, 'hello.js oluşturulacak');
  assert.deepEqual([...debaters].sort(), ['c1', 'w1', 'w2']);

  assert.ok(orch.approve('telegram').ok);
  assert.equal(orch.approve('tui').ok, false); // second approval rejected
  const done = await waitFor(sm, Status.DONE);
  const file = path.join(workspace.root, 'hello.js');
  assert.equal(fs.readFileSync(file, 'utf8'), "console.log('hello');\n");
  assert.ok(done.diff.files.some((f) => f.path === 'hello.js' && f.status === 'A'));
  assert.equal(done.tasks[0].status, 'done');

  assert.ok((await orch.rollback('tui')).ok);
  assert.equal(fs.existsSync(file), false);
  assert.equal(sm.status, Status.IDLE);
});

test('chief rate limit hands chief role to fallback without losing the session', async () => {
  const { sm, orch } = setup({ c1: fakeAgent('Chief', 'ratelimit'), w1: fakeAgent('W1'), w2: fakeAgent('W2') });
  const failovers = [];
  sm.on('failover', (f) => failovers.push(f));
  orch.submit('hello.js yaz');
  const planned = await waitFor(sm, Status.AWAITING_APPROVAL);
  assert.equal(planned.chief, 'w1');
  assert.deepEqual(failovers.map((f) => [f.from, f.to, f.reason]), [['c1', 'w1', 'RATE_LIMIT']]);
  assert.ok(planned.workers.includes('c1'));
  assert.equal(planned.prompt, 'hello.js yaz');
});

test('worker failure moves the task to a backup worker', async () => {
  const { sm, orch, workspace } = setup(
    { c1: fakeAgent('Chief'), w1: fakeAgent('W1', 'ratelimit'), w2: fakeAgent('W2') },
    { fallbackChief: 'w2' },
  );
  orch.submit('hello.js yaz');
  await waitFor(sm, Status.AWAITING_APPROVAL);
  orch.approve();
  const done = await waitFor(sm, Status.DONE);
  assert.equal(done.tasks[0].status, 'done');
  assert.equal(done.tasks[0].worker, 'w2');
  assert.ok(fs.existsSync(path.join(workspace.root, 'hello.js')));
});

test('abort during debate kills processes and ignores late results', async () => {
  const { sm, orch } = setup({ c1: fakeAgent('Chief', 'hang'), w1: fakeAgent('W1'), w2: fakeAgent('W2') });
  orch.submit('x');
  await new Promise((r) => setTimeout(r, 400));
  const res = orch.abort('telegram');
  assert.ok(res.ok);
  assert.equal(sm.status, Status.ABORTED);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(sm.status, Status.ABORTED);
});

test('approving a plan with no file changes closes the round without building', async () => {
  const { sm, orch, workspace } = setup({ c1: fakeAgent('Chief', 'noop'), w1: fakeAgent('W1'), w2: fakeAgent('W2') });
  const chiefCalls = [];
  sm.on('chunk', (c) => c.kind === 'start' && c.role === 'chief' && chiefCalls.push(c));
  orch.submit('deneme');
  const planned = await waitFor(sm, Status.AWAITING_APPROVAL);
  assert.deepEqual(planned.plan.files_to_modify, []);
  assert.deepEqual(planned.plan.questions, ['Ne inşa etmek istiyorsun?']);
  const before = chiefCalls.length;

  const res = orch.approve('tui');
  assert.ok(res.ok && res.noop);
  assert.equal(sm.status, Status.IDLE);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(chiefCalls.length, before); // no decomposition call
  assert.equal(fs.existsSync(path.join(workspace.root, '.kerberos', 'shadow.git')), false); // no snapshot
});

test('setChief swaps roles when idle', () => {
  const { sm, orch } = setup({ c1: fakeAgent('Chief'), w1: fakeAgent('W1'), w2: fakeAgent('W2') });
  assert.ok(orch.setChief('w2').ok);
  assert.equal(sm.chief, 'w2');
  assert.deepEqual(sm.workers, ['c1', 'w1']);
});
