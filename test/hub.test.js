import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { Telegram } from 'telegraf';
import { HubLink, rememberTopic, threadOf } from '../src/remote/hub.js';
import { TelegramBridge } from '../src/remote/telegram.js';
import { StateMachine } from '../src/core/state-machine.js';
import { SessionStore } from '../src/core/sessions.js';
import { tmpDir } from './helpers.js';

const OWNER = 111;

const tmpAddress = (dir) => (process.platform === 'win32' ? `\\\\.\\pipe\\kerberos-test-${crypto.randomUUID()}` : path.join(dir, 'hub.sock'));

/** Bot API stand-in: getUpdates long-polls a queue, everything else is recorded. */
function fakeApi({ topics = true } = {}) {
  const calls = [];
  const queue = [];
  let wake = null;
  let thread = 500;
  return {
    calls,
    push(u) {
      queue.push(u);
      wake?.();
    },
    async callApi(method, payload, { signal } = {}) {
      if (method === 'getUpdates') {
        if (payload.timeout === 0) return [];
        if (!queue.length) {
          await new Promise((resolve, reject) => {
            wake = resolve;
            signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
          });
        }
        return queue.splice(0).filter((u) => u.update_id >= payload.offset);
      }
      calls.push({ method, payload });
      if (method === 'getMe') return { id: 1, is_bot: true, first_name: 'K', username: 'kerberos_test_bot', has_topics_enabled: topics };
      if (method === 'createForumTopic') return { message_thread_id: thread++, name: payload.name };
      if (method === 'sendMessage') return { message_id: calls.length, chat: { id: payload.chat_id }, text: payload.text };
      return true;
    },
  };
}

let uid = 1;
const msg = (from, text, thread) => ({
  update_id: uid++,
  message: {
    message_id: uid,
    date: 0, chat: { id: from, type: 'private' }, from: { id: from, is_bot: false, first_name: 'u' }, text,
    ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } : {}),
    ...(thread ? { message_thread_id: thread, is_topic_message: true } : {}),
  },
});
const until = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

function pair(t, { topics = true } = {}) {
  const dir = tmpDir();
  const api = fakeApi({ topics });
  const opts = { token: '1:fake', allowedUserId: OWNER, topics, address: tmpAddress(dir), topicsPath: path.join(dir, 'topics.json'), api };
  const a = new HubLink(opts);
  const b = new HubLink(opts);
  t.after(() => Promise.all([a.leave(), b.leave()]));
  return { a, b, api, opts };
}

test('threadOf reads messages and button presses', () => {
  assert.equal(threadOf(msg(OWNER, 'x', 7)), 7);
  assert.equal(threadOf({ callback_query: { message: { message_thread_id: 9 } } }), 9);
  assert.equal(threadOf(msg(OWNER, 'x')), null);
});

test('hub routes updates to the process owning the topic; strangers are dropped', async (t) => {
  const { a, b, api } = pair(t);
  assert.equal(await a.join({ threadId: 10, root: '/p/one', title: 'bir' }), 'hub');
  assert.equal(await b.join({ threadId: 20, root: '/p/two', title: 'iki' }), 'client');
  await until(() => a.members.size === 2);

  const gotA = [];
  const gotB = [];
  a.on('update', (u) => gotA.push(u));
  b.on('update', (u) => gotB.push(u));
  api.push(msg(OWNER, 'ikinci projeye', 20));
  api.push(msg(OWNER, 'birinci projeye', 10));
  api.push(msg(999, 'yabancı', 20));
  await until(() => gotA.length === 1 && gotB.length === 1);
  assert.equal(gotB[0].message.text, 'ikinci projeye');
  assert.equal(gotA[0].message.text, 'birinci projeye');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(gotB.length, 1); // stranger never forwarded
});

test('lobby topic lists sessions; a closed session’s topic says how to resume', async (t) => {
  const { a, b, api, opts } = pair(t);
  await a.join({ threadId: 10, root: '/p/one', title: 'bir' });
  await b.join({ threadId: 20, root: '/p/two', title: 'iki' });
  await until(() => a.members.size === 2);
  await a.lobbyReady;
  const sends = () => api.calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload);

  // The hub opens one fixed lobby topic and greets there.
  const lobby = api.calls.find((c) => c.method === 'createForumTopic');
  assert.equal(lobby.payload.name, '🐺 Kerberos');
  assert.equal(sends()[0].message_thread_id, a.lobbyThread);
  assert.match(sends()[0].text, /Kerberos lobisi/);

  api.push(msg(OWNER, '/sessions', a.lobbyThread));
  await until(() => sends().length === 2);
  assert.equal(sends()[1].message_thread_id, a.lobbyThread);
  assert.match(sends()[1].text, /Açık oturumlar<\/b> \(2\)\n\n📁 <b>one<\/b> · [\s\S]*bir\n📁 <b>two<\/b>/);
  assert.doesNotMatch(sends()[1].text, /\/p\//); // folder names, not full paths

  rememberTopic(opts.topicsPath, 30, { sessionId: 'abcdef1234', root: '/p/old', title: 'eski iş' });
  api.push(msg(OWNER, 'merhaba', 30));
  await until(() => sends().length === 3);
  assert.equal(sends()[2].message_thread_id, 30);
  assert.match(sends()[2].text, /açık değil[\s\S]*kerberos --resume abcdef12/);

  // Writing outside every topic makes Telegram open a fresh one: answered, pointed at the lobby.
  api.push(msg(OWNER, '/sessions', 40));
  await until(() => sends().length === 4);
  assert.equal(sends()[3].message_thread_id, 40);
  assert.match(sends()[3].text, /Açık oturumlar/);
  api.push(msg(OWNER, 'merhaba', 41));
  await until(() => sends().length === 5);
  assert.match(sends()[4].text, /kerberos --rc[\s\S]*🐺 Kerberos/);

  // /sessions inside a project topic is answered by the hub, not routed to the project.
  api.push(msg(OWNER, '/sessions', 20));
  await until(() => sends().length === 6);
  assert.equal(sends()[5].message_thread_id, 20);
  assert.match(sends()[5].text, /Açık oturumlar<\/b> \(2\)/);
});

test('without topic mode the newest Kerberos gets the single chat', async (t) => {
  const { a, b, api } = pair(t, { topics: false });
  await a.join({ threadId: null, root: '/p/one' });
  await b.join({ threadId: null, root: '/p/two' });
  await until(() => a.members.size === 2);
  const gotB = [];
  b.on('update', (u) => gotB.push(u));
  api.push(msg(OWNER, 'görev'));
  await until(() => gotB.length === 1);
});

test('when the hub leaves, a client takes over polling', async (t) => {
  const { a, b } = pair(t);
  await a.join({ threadId: 10, root: '/p/one' });
  await b.join({ threadId: 20, root: '/p/two' });
  const roles = [];
  b.on('role', (r) => roles.push(r));
  await a.leave();
  await until(() => b.role === 'hub');
  assert.deepEqual(roles, ['hub']);
});

// ------------------------------------------------------------------ bridge + topics

// Bridge Telegraf clients talk to the same fake; never reaches api.telegram.org.
let current = null;
Telegram.prototype.callApi = function (method, payload, opts) {
  return current.callApi(method, payload, opts);
};

function bridgeEnv({ topics = true } = {}) {
  const dir = tmpDir();
  const api = (current = fakeApi({ topics }));
  return { dir, api, store: new SessionStore(path.join(dir, '.kerberos')), hub: { address: tmpAddress(dir), topicsPath: path.join(dir, 'topics.json'), api } };
}

async function startBridge(t, env, { session = env.store.create(), root = path.join(env.dir, 'proje') } = {}) {
  const sm = new StateMachine({ chief: 'claude', workers: [], agents: { claude: { label: 'Claude' } } });
  const orch = { submit: (text) => (sm.transition('submit', { prompt: text }, 'telegram'), { ok: true }) };
  const bridge = new TelegramBridge({ token: '1:fake', allowedUserId: OWNER, sm, orch, root, hub: env.hub });
  bridge.bindSession(session);
  t.after(() => bridge.stop({ notify: false }));
  const res = await bridge.start();
  assert.ok(res.ok, res.reason);
  await bridge.flush();
  return { sm, session, bridge };
}

const projectTopicsCreated = (api) => api.calls.filter((c) => c.method === 'createForumTopic' && c.payload.name.startsWith('📁'));

test('RC with topic mode: the folder gets a topic, every message goes into it', async (t) => {
  const env = bridgeEnv();
  const { api, store } = env;
  const { sm, session, bridge } = await startBridge(t, env);
  const [created] = projectTopicsCreated(api);
  assert.equal(created.payload.chat_id, OWNER);
  assert.equal(created.payload.name, '📁 proje');
  assert.equal(bridge.role, 'hub');
  const thread = bridge.threadId;
  await session.writing;
  assert.equal(store.open(session.id).meta.telegramThreadId, thread); // survives a resume

  // A task typed into the topic reaches this session; replies stay in the topic.
  current.push(msg(OWNER, 'JWT auth ekle', thread));
  await until(() => sm.status === 'DEBATING');
  sm.emit('triage', { kind: 'task', turnId: sm.turnId });
  session.meta.title = 'JWT auth ekle'; // the session tracker does this in the app
  bridge.retitle();
  await until(() => api.calls.some((c) => c.method === 'editForumTopic'));
  await bridge.flush();
  const sends = api.calls.filter((c) => c.method === 'sendMessage' && !/Kerberos lobisi/.test(c.payload.text));
  assert.ok(sends.length >= 2);
  assert.ok(sends.every((c) => c.payload.message_thread_id === thread));
  assert.equal(api.calls.find((c) => c.method === 'editForumTopic').payload.name, '📁 proje · JWT auth ekle');
});

test('a new session in the same folder reuses its topic', async (t) => {
  const env = bridgeEnv();
  const first = await startBridge(t, env);
  const thread = first.bridge.threadId;
  await first.bridge.stop({ notify: false });

  const second = await startBridge(t, env);
  assert.equal(second.bridge.threadId, thread);
  assert.equal(projectTopicsCreated(env.api).length, 1);
  const hello = env.api.calls.filter((c) => c.method === 'sendMessage').at(-1).payload;
  assert.equal(hello.message_thread_id, thread);
  assert.match(hello.text, new RegExp(`Yeni sohbet</b> · <code>${second.session.shortId}</code>`));
});

test('two Kerberos in the same folder at once get separate topics', async (t) => {
  const env = bridgeEnv();
  const a = await startBridge(t, env);
  const b = await startBridge(t, env);
  assert.equal(b.bridge.role, 'client');
  assert.notEqual(a.bridge.threadId, b.bridge.threadId);
  assert.equal(projectTopicsCreated(env.api).length, 2);
});

test('RC without topic mode falls back to the single chat', async (t) => {
  const env = bridgeEnv({ topics: false });
  await startBridge(t, env);
  assert.equal(env.api.calls.filter((c) => c.method === 'createForumTopic').length, 0);
  const sends = env.api.calls.filter((c) => c.method === 'sendMessage');
  assert.ok(sends.length >= 1);
  assert.ok(sends.every((c) => c.payload.message_thread_id === undefined));
});

test('/clear deletes this session’s messages and starts a new session in the same topic', async (t) => {
  const env = bridgeEnv();
  const { bridge, session } = await startBridge(t, env);
  const thread = bridge.threadId;
  const fresh = env.store.create();
  bridge.sessions = { newSession: async () => (bridge.bindSession(fresh), { ok: true }) };

  current.push(msg(OWNER, '/status', thread));
  await until(() => env.api.calls.filter((c) => c.method === 'sendMessage').length >= 3);
  await bridge.flush();
  const before = [...session.meta.telegramMessages];
  assert.ok(before.length >= 3); // greeting, the /status command, its answer

  current.push(msg(OWNER, '/clear', thread));
  await until(() => env.api.calls.some((c) => c.method === 'deleteMessages'));
  await until(() => bridge.session === fresh);
  await bridge.flush();
  const del = env.api.calls.find((c) => c.method === 'deleteMessages').payload;
  for (const id of before) assert.ok(del.message_ids.includes(id));
  const banner = env.api.calls.filter((c) => c.method === 'sendMessage').at(-1).payload;
  assert.equal(banner.message_thread_id, thread);
  assert.match(banner.text, new RegExp(`Yeni sohbet</b> · <code>${fresh.shortId}</code>`));
});
