import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Telegram } from 'telegraf';
import { TelegramBridge, formatPlan, esc } from '../src/remote/telegram.js';
import { StateMachine } from '../src/core/state-machine.js';

const OWNER = 111;
const STRANGER = 999;

/** Bridge wired to a fake Bot API; records every outbound call. */
function setup() {
  const sm = new StateMachine({ chief: 'claude', workers: ['codex'], agents: { claude: { label: 'Claude' }, codex: { label: 'Codex' } } });
  const calls = { orch: [] };
  const orch = {
    submit: (t, s) => (calls.orch.push(['submit', t, s]), sm.transition('submit', { prompt: t }, s) ? { ok: true } : { ok: false, reason: 'busy' }),
    approve: (s) => (calls.orch.push(['approve', s]), sm.transition('approve', {}, s) ? { ok: true } : { ok: false, reason: 'no plan' }),
    replan: (f, s) => (calls.orch.push(['replan', f, s]), sm.transition('replan', {}, s) ? { ok: true } : { ok: false, reason: 'x' }),
    cancel: (s) => (calls.orch.push(['cancel', s]), sm.transition('cancel', {}, s) ? { ok: true } : { ok: false, reason: 'x' }),
    abort: (s) => (calls.orch.push(['abort', s]), sm.transition('abort', {}, s) ? { ok: true, killed: 2 } : { ok: false, reason: 'idle' }),
    accept: () => ({ ok: true }),
    rollback: async () => ({ ok: true }),
  };
  const bridge = new TelegramBridge({ token: '1:fake', allowedUserId: OWNER, sm, orch });
  const bot = bridge.createBot();
  bot.botInfo = { id: 1, is_bot: true, username: 'kerberos_test_bot', first_name: 'K' };
  api.length = 0;
  nextId = 100;
  bridge.attach();
  return { sm, bridge, bot, api, calls };
}

// Telegraf creates a fresh Telegram client per update, so stub at the prototype.
// This also guarantees the tests never reach api.telegram.org.
const api = [];
let nextId = 100;
Telegram.prototype.callApi = async function (method, payload) {
  api.push({ method, payload });
  return method === 'sendMessage' ? { message_id: nextId++, chat: { id: payload.chat_id }, text: payload.text } : true;
};

let updateId = 1;
const textUpdate = (from, text) => ({
  update_id: updateId++,
  message: { message_id: updateId, date: 0, chat: { id: from, type: 'private' }, from: { id: from, is_bot: false, first_name: 'u' }, text, ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } : {}) },
});
const buttonUpdate = (from, data) => ({
  update_id: updateId++,
  callback_query: { id: String(updateId), from: { id: from, is_bot: false, first_name: 'u' }, chat_instance: 'c', data, message: { message_id: 100, date: 0, chat: { id: from, type: 'private' }, text: 'x' } },
});

test('strangers are silently ignored', async () => {
  const { bot, api, calls } = setup();
  await bot.handleUpdate(textUpdate(STRANGER, 'rm -rf everything'));
  await bot.handleUpdate(textUpdate(STRANGER, '/abort'));
  await bot.handleUpdate(buttonUpdate(STRANGER, 'approve:abc'));
  assert.equal(api.length, 0);
  assert.equal(calls.orch.length, 0);
});

test('owner message starts a debate; plan arrives with buttons; button approves', async () => {
  const { sm, bridge, bot, api, calls } = setup();
  await bot.handleUpdate(textUpdate(OWNER, 'JWT auth ekle'));
  assert.deepEqual(calls.orch[0], ['submit', 'JWT auth ekle', 'telegram']);
  await bridge.flush();
  assert.match(api.at(-1).payload.text, /Tartışma başladı/);

  sm.transition('planReady', { plan: { summary: 'S <b>', files_to_modify: ['a.js'], dependencies: [], risks: [] } });
  await bridge.flush();
  const planMsg = api.at(-1);
  assert.match(planMsg.payload.text, /S &lt;b&gt;/);
  const buttons = planMsg.payload.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(buttons, [`approve:${sm.sessionId}`, `replan:${sm.sessionId}`, `cancel:${sm.sessionId}`]);

  await bot.handleUpdate(buttonUpdate(OWNER, `approve:${sm.sessionId}`));
  await bridge.flush();
  assert.equal(sm.status, 'BUILDING');
  const edit = api.find((c) => c.method === 'editMessageText');
  assert.equal(edit.payload.message_id, 101); // 100 = "debate started", 101 = plan
  assert.match(edit.payload.text, /Onaylandı \(Telegram'dan\)/);
});

test('stale buttons from an older session are rejected', async () => {
  const { sm, bot, calls } = setup();
  sm.transition('submit', { prompt: 'x' });
  sm.transition('planReady', { plan: { summary: 's', files_to_modify: [], dependencies: [], risks: [] } });
  await bot.handleUpdate(buttonUpdate(OWNER, 'approve:deadbeef'));
  assert.equal(sm.status, 'AWAITING_APPROVAL');
  assert.equal(calls.orch.filter((c) => c[0] === 'approve').length, 0);
});

test('TUI approval edits the Telegram plan message (two-way sync)', async () => {
  const { sm, bridge, api } = setup();
  sm.transition('submit', { prompt: 'x' }, 'tui');
  sm.transition('planReady', { plan: { summary: 's', files_to_modify: [], dependencies: [], risks: [] } });
  sm.transition('approve', {}, 'tui'); // before the plan message has even been sent
  await bridge.flush();
  const edit = api.find((c) => c.method === 'editMessageText');
  assert.ok(edit, 'plan message should be edited');
  assert.match(edit.payload.text, /Onaylandı \(TUI'den\)/);
  assert.equal(edit.payload.reply_markup, undefined); // keyboard removed
});

test('/abort from the owner stops the run', async () => {
  const { sm, bot, bridge, api } = setup();
  sm.transition('submit', { prompt: 'x' });
  await bot.handleUpdate(textUpdate(OWNER, '/abort'));
  await bridge.flush();
  assert.equal(sm.status, 'ABORTED');
  assert.ok(api.some((c) => /Acil durdurma: 2/.test(c.payload.text || '')));
});

test('formatPlan escapes HTML and stays under Telegram limits', () => {
  const long = 'x'.repeat(10_000);
  const text = formatPlan({ summary: long, files_to_modify: [], dependencies: [], risks: [] }, '<script>');
  assert.ok(text.length < 4096);
  assert.match(text, /&lt;script&gt;/);
  assert.equal(esc('a&b'), 'a&amp;b');
});
