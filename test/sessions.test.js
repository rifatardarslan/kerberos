import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SessionController, SessionStore } from '../src/core/sessions.js';
import { StateMachine, Status } from '../src/core/state-machine.js';
import { renderHistory } from '../src/core/prompts.js';
import { parseMentions } from '../src/core/orchestrator.js';
import { tmpDir } from './helpers.js';
import { setLanguage } from '../src/i18n/index.js';

// These tests check the Turkish interface text.
setLanguage('tr');

const fakeOrch = () => ({
  adapters: { claude: {}, codex: {} },
  setChief: () => ({ ok: true }),
  updateAgent: () => ({ ok: true }),
  setPermissionMode: () => ({ ok: true }),
});

test('sessions are written lazily and listed newest first', async () => {
  const store = new SessionStore(tmpDir());
  const a = store.create();
  assert.equal(store.list().length, 0); // nothing on disk until something happens
  await a.save({ title: 'ilk' });
  await new Promise((r) => setTimeout(r, 5));
  const b = store.create();
  await b.save({ title: 'ikinci' });
  assert.deepEqual(
    store.list().map((m) => m.title),
    ['ikinci', 'ilk'],
  );
  assert.equal(store.latest().id, b.id);
});

test('open() accepts a unique id prefix and explains misses', async () => {
  const store = new SessionStore(tmpDir());
  const s = store.create();
  await s.save({ title: 'x' });
  assert.equal(store.open(s.shortId).id, s.id);
  assert.equal(store.open(s.id).id, s.id);
  assert.throws(() => store.open('zzzz'), /bulunamadı/);
});

test('transcript items are appended and replayed; ephemeral ones are skipped', async () => {
  const store = new SessionStore(tmpDir());
  const s = store.create();
  await s.appendItem({ id: 1, type: 'user', text: 'merhaba' });
  await s.appendItem({ id: 2, type: 'help' });
  await s.appendItem({ id: 3, type: 'agent', label: 'Claude', text: 'selam' });
  const back = store.open(s.id).items();
  assert.deepEqual(
    back.map((i) => i.type),
    ['user', 'agent'],
  );
  assert.equal(back[0].id, undefined);
});

test('tracker records turns, outcome, RC and the undoable build', async () => {
  const store = new SessionStore(tmpDir());
  const sm = new StateMachine({ chief: 'claude', workers: ['codex'] });
  const telegram = new EventEmitter();
  const ctl = new SessionController({ store, sm, orch: fakeOrch(), telegram });
  const s = store.create();
  await ctl.activate(s);

  // Small talk first: answered by the chief, does not name the session.
  sm.transition('submit', { prompt: 'selam' });
  sm.emit('triage', { kind: 'chat', turnId: sm.turnId });
  sm.transition('answer', { answer: 'Merhaba! Ne yapalım?' });
  assert.equal(s.meta.title, null);

  sm.transition('submit', { prompt: 'JWT auth ekle' });
  sm.emit('triage', { kind: 'task', turnId: sm.turnId });
  sm.transition('planReady', { plan: { summary: 'jwt', files_to_modify: ['a.js'] } });
  sm.transition('approve');
  sm.update({ snapshotSha: 'abc123' });
  sm.transition('buildDone', { diff: { files: [{ path: 'a.js', status: 'A' }] } });
  telegram.emit('status', 'on');
  await s.writing;

  const meta = store.open(s.id).meta;
  assert.equal(meta.title, 'JWT auth ekle');
  assert.equal(meta.rc, true);
  assert.equal(meta.turns.length, 2);
  assert.deepEqual([meta.turns[0].kind, meta.turns[0].outcome, meta.turns[0].answer], ['chat', 'answered', 'Merhaba! Ne yapalım?']);
  assert.equal(meta.turns[1].outcome, 'applied');
  assert.equal(meta.turns[1].snapshot, 'abc123');
  assert.deepEqual(meta.turns[1].files, [{ path: 'a.js', status: 'A' }]);
  assert.equal(meta.last.snapshot, 'abc123');
  assert.equal(sm.session.title, 'JWT auth ekle');

  // RC turned off by shutting down must not be remembered as "off".
  ctl.current.closing = true;
  telegram.emit('status', 'off');
  await s.writing;
  assert.equal(store.open(s.id).meta.rc, true);
});

test('resuming restores the finished build so it can still be undone', async () => {
  const dir = tmpDir();
  const store = new SessionStore(dir);
  const s = store.create();
  await s.save({ last: { status: 'DONE', turnId: 't1', prompt: 'p', plan: { summary: 's', files_to_modify: [] }, diff: { files: [] }, snapshot: 'sha1' }, permissionMode: 'auto' });

  const sm = new StateMachine({ chief: 'claude' });
  let mode = null;
  const orch = { ...fakeOrch(), setPermissionMode: (m) => ((mode = m), { ok: true }) };
  const ctl = new SessionController({ store, sm, orch });
  const res = await ctl.resume(s.shortId);
  assert.ok(res.ok);
  assert.equal(sm.status, Status.DONE);
  assert.equal(sm.snapshotSha, 'sha1');
  assert.equal(mode, 'auto');
  assert.equal(typeof orch.history, 'function');

  const fresh = await ctl.newSession();
  assert.ok(fresh.ok);
  assert.equal(sm.status, Status.IDLE);
  assert.equal(sm.snapshotSha, null);
});

test('legacy .kerberos/session.json with a pending build becomes a session', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ status: 'DONE', sessionId: 'old1', prompt: 'eski', snapshot: 'sha0', diff: { files: [] } }));
  const store = new SessionStore(dir);
  const s = store.migrateLegacy();
  assert.equal(s.meta.last.snapshot, 'sha0');
  assert.equal(fs.existsSync(path.join(dir, 'session.json')), false);
  assert.equal(store.migrateLegacy(), null); // only once
});

test('history keeps the newest turns within budget', () => {
  const turns = Array.from({ length: 10 }, (_, i) => ({ request: `istek ${i + 1}`, outcome: 'applied', files: [{ status: 'M', path: `f${i}.js` }] }));
  const h = renderHistory(turns);
  assert.match(h, /### Turn 10 \(applied\)/);
  assert.match(h, /### Turn 5 /);
  assert.doesNotMatch(h, /### Turn 4 /);
  // Older turns are not forgotten: one line each.
  assert.match(h, /Older turns \(brief\)\n- Turn 1 \(applied\): istek 1 → f0\.js[\s\S]*- Turn 4 /);
  const big = renderHistory(turns.map((t) => ({ ...t, planSummary: 'x'.repeat(790) })));
  assert.ok(big.length <= 6000 + 1500 + 200 || big.split('### Turn').length === 2);
  assert.match(big, /### Turn 10/);
  assert.match(renderHistory(turns.slice(-2), 'Önce JWT eklendi.'), /^### Summary of the conversation before these turns\nÖnce JWT eklendi\./);
});

test('/compact folds earlier turns into a summary that later prompts carry', async () => {
  const store = new SessionStore(tmpDir());
  const sm = new StateMachine({ chief: 'claude', workers: ['codex'], agents: { claude: {}, codex: {} } });
  const prompts = [];
  const orch = { ...fakeOrch(), callChief: async (p) => (prompts.push(p), 'JWT auth eklendi; testler bekliyor.') };
  const sessions = new SessionController({ store, sm, orch });
  await sessions.activate(store.create());
  const s = sessions.current;
  s.meta.turns.push({ id: 't1', request: 'JWT auth ekle', outcome: 'applied', files: [{ path: 'src/auth.js', status: 'A' }] });
  s.meta.turns.push({ id: 't2', request: 'refresh token', outcome: 'rolledBack', files: [] });

  const res = await sessions.compact('refresh token kararı');
  assert.ok(res.ok, res.reason);
  assert.equal(res.turns, 2);
  assert.match(prompts[0], /Keep the following especially: refresh token kararı[\s\S]*JWT auth ekle/);
  assert.equal(orch.summary(), 'JWT auth eklendi; testler bekliyor.');
  assert.deepEqual(orch.history(), []); // folded into the summary
  assert.equal((await sessions.compact()).ok, false); // nothing new to fold

  s.meta.turns.push({ id: 't3', request: 'test ekle', outcome: 'applied', files: [] });
  assert.deepEqual(orch.history().map((t) => t.id), ['t3']);
  assert.equal(store.open(s.id).meta.summary.upToTurnId, 't2'); // survives a resume
});

test('parseMentions finds @paths', () => {
  assert.deepEqual(parseMentions('@src/a.js ile @b.md ve e@mail.com, @src/a.js'), ['src/a.js', 'b.md']);
});
