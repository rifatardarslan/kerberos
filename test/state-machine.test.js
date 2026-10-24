import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StateMachine, Status } from '../src/core/state-machine.js';

test('happy path transitions and modes', () => {
  const sm = new StateMachine({ chief: 'claude' });
  const seen = [];
  sm.on('state', (s, meta) => seen.push(`${meta.action}:${s.status}:${s.mode}`));
  assert.ok(sm.transition('submit', { prompt: 'x' }));
  assert.ok(sm.sessionId);
  assert.ok(sm.transition('planReady', { plan: { summary: 's' } }));
  assert.ok(sm.transition('approve', {}, 'telegram'));
  assert.ok(sm.transition('buildDone'));
  assert.deepEqual(seen, [
    'submit:DEBATING:PLANNING',
    'planReady:AWAITING_APPROVAL:PLANNING',
    'approve:BUILDING:CODING',
    'buildDone:DONE:CODING',
  ]);
});

test('invalid transitions are rejected; double approve only applies once', () => {
  const sm = new StateMachine({ chief: 'claude' });
  assert.equal(sm.transition('approve'), false);
  sm.transition('submit', { prompt: 'x' });
  sm.transition('planReady', { plan: {} });
  let approvals = 0;
  sm.on('state', (_s, m) => m.action === 'approve' && approvals++);
  assert.equal(sm.transition('approve', {}, 'tui'), true);
  assert.equal(sm.transition('approve', {}, 'telegram'), false);
  assert.equal(approvals, 1);
  assert.equal(sm.transition('submit'), false); // busy building
  assert.equal(sm.transition('abort'), true);
  assert.equal(sm.status, Status.ABORTED);
  assert.equal(sm.transition('fail'), false);
});

test('new submit resets session data', () => {
  const sm = new StateMachine({ chief: 'claude' });
  sm.transition('submit', { prompt: 'a' });
  const first = sm.sessionId;
  sm.transition('fail', { error: 'boom' });
  sm.transition('submit', { prompt: 'b' });
  assert.notEqual(sm.sessionId, first);
  assert.equal(sm.error, null);
});
