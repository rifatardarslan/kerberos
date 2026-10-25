import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Telegram } from 'telegraf';
import { TelegramBridge, esc, rcCommand } from '../src/remote/telegram.js';
import { mdToHtml, planCard, splitMarkdown, plain } from '../src/remote/format.js';
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
    setPermissionMode: (m) => (sm.update({ permissionMode: m }), { ok: true }),
    cyclePermissionMode: () => (sm.update({ permissionMode: sm.permissionMode === 'auto' ? 'plan' : 'auto' }), { ok: true }),
    // Same contract as Orchestrator.answerQuestion / openQuestion.
    answerQuestion: (i, a, s) => {
      calls.orch.push(['answerQuestion', i, a, s]);
      const answers = [...sm.answers];
      answers[i] = a;
      sm.update({ answers });
      if (sm.questions.every((_, k) => answers[k] != null)) sm.transition('answered', {}, s);
      return { ok: true };
    },
    get openQuestion() {
      return sm.status === 'AWAITING_ANSWERS' ? sm.questions.findIndex((_, k) => sm.answers[k] == null) : -1;
    },
  };
  const workspace = { diffText: async () => 'diff --git a/a.js b/a.js\n+x\n' };
  const bridge = new TelegramBridge({ token: '1:fake', allowedUserId: OWNER, sm, orch, workspace, root: '/p/demo', logger: (t) => process.env.TGDEBUG && console.log('LOG', t) });
  const bot = bridge.createBot();
  bot.botInfo = { id: 1, is_bot: true, username: 'kerberos_test_bot', first_name: 'K' };
  api.length = 0;
  nextId = 100;
  failHtml = false;
  bridge.attach();
  return { sm, bridge, bot, api, calls };
}

// Telegraf creates a fresh Telegram client per update, so stub at the prototype.
// This also guarantees the tests never reach api.telegram.org.
const api = [];
let nextId = 100;
let failHtml = false;
Telegram.prototype.callApi = async function (method, payload) {
  if (failHtml && payload.parse_mode === 'HTML') throw new Error("400: Bad Request: can't parse entities: unexpected end tag");
  api.push({ method, payload });
  return method === 'sendMessage' ? { message_id: nextId++, chat: { id: payload.chat_id }, text: payload.text } : true;
};

let updateId = 1;
const textUpdate = (from, text) => ({
  update_id: updateId++,
  message: { message_id: updateId, date: 0, chat: { id: from, type: 'private' }, from: { id: from, is_bot: false, first_name: 'u' }, text, ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } : {}) },
});
const buttonUpdate = (from, data, messageId = 100) => ({
  update_id: updateId++,
  callback_query: { id: String(updateId), from: { id: from, is_bot: false, first_name: 'u' }, chat_instance: 'c', data, message: { message_id: messageId, date: 0, chat: { id: from, type: 'private' }, text: 'x' } },
});
const sent = () => api.filter((c) => c.method === 'sendMessage');
const buttonsOf = (call) => call.payload.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
/** Let the live card's (throttled) edit run. */
const settle = async (bridge) => {
  await new Promise((r) => setTimeout(r, 5));
  await bridge.flush();
};

test('strangers are silently ignored', async () => {
  const { bot, api, calls } = setup();
  await bot.handleUpdate(textUpdate(STRANGER, 'rm -rf everything'));
  await bot.handleUpdate(textUpdate(STRANGER, '/stop'));
  await bot.handleUpdate(buttonUpdate(STRANGER, 'approve:abc'));
  assert.equal(api.length, 0);
  assert.equal(calls.orch.length, 0);
});

test('a task gets one live card, then the plan with buttons; the button approves', async () => {
  const { sm, bridge, bot, api, calls } = setup();
  await bot.handleUpdate(textUpdate(OWNER, 'JWT auth ekle'));
  assert.deepEqual(calls.orch[0], ['submit', 'JWT auth ekle', 'telegram']);
  await bridge.flush();
  assert.equal(api.at(-1).method, 'sendChatAction'); // "typing…" while the chief decides

  sm.emit('triage', { kind: 'task', turnId: sm.turnId });
  await bridge.flush();
  const card = sent().at(-1);
  assert.match(card.payload.text, /Tartışma/);
  assert.match(card.payload.text, /✅ Claude · taslak/);
  assert.deepEqual(buttonsOf(card), [`stop:${sm.turnId}`]);

  // The card is edited in place as workers start and finish.
  sm.chunk({ agent: 'codex', label: 'Codex', step: 'critique', kind: 'start' });
  await settle(bridge);
  const live = api.filter((c) => c.method === 'editMessageText').at(-1);
  assert.equal(live.payload.message_id, card.payload.message_id ?? 100);
  assert.match(live.payload.text, /⏳ Codex · eleştiri/);
  assert.match(live.payload.text, /Ekip taslağı eleştiriyor/);

  sm.transition('planReady', { plan: { summary: 'S **kalın** <b>', files_to_modify: ['a.js'], dependencies: [], risks: ['r1'] } });
  await bridge.flush();
  const collapsed = api.filter((c) => c.method === 'editMessageText').at(-1);
  assert.match(collapsed.payload.text, /plan hazır/);
  assert.equal(collapsed.payload.reply_markup, undefined); // the stop button goes away
  const planMsg = sent().at(-1);
  assert.match(planMsg.payload.text, /Plan hazır<\/b> · 1 dosya/);
  assert.match(planMsg.payload.text, /S <b>kalın<\/b> &lt;b&gt;/);
  assert.match(planMsg.payload.text, /<code>a\.js<\/code>/);
  assert.match(planMsg.payload.text, /<blockquote expandable>⚠️ <b>Riskler<\/b>\n• r1/);
  assert.deepEqual(buttonsOf(planMsg), [`approve:${sm.turnId}`, `cancel:${sm.turnId}`, `auto:${sm.turnId}`]);

  await bot.handleUpdate(buttonUpdate(OWNER, `approve:${sm.turnId}`));
  await bridge.flush();
  assert.equal(sm.status, 'BUILDING');
  const edit = api.filter((c) => c.method === 'editMessageText').at(-1);
  assert.equal(edit.payload.message_id, planMsg.payload.message_id ?? 101);
  assert.match(edit.payload.text, /Onaylandı · Telegram/);
  assert.match(sent().at(-1).payload.text, /Kodlanıyor/); // the build gets its own card
});

test('"code, and don\'t ask again" switches to auto mode and approves', async () => {
  const { sm, bridge, bot } = setup();
  sm.transition('submit', { prompt: 'x' });
  sm.transition('planReady', { plan: { summary: 's', files_to_modify: ['a.js'], dependencies: [], risks: [] } });
  await bot.handleUpdate(buttonUpdate(OWNER, `auto:${sm.turnId}`));
  await bridge.flush();
  assert.equal(sm.permissionMode, 'auto');
  assert.equal(sm.status, 'BUILDING');
});

test('stale buttons from an older turn are rejected', async () => {
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
  sm.transition('planReady', { plan: { summary: 's', files_to_modify: ['a.js'], dependencies: [], risks: [] } });
  sm.transition('approve', {}, 'tui'); // before the plan message has even been sent
  await bridge.flush();
  const edit = api.find((c) => c.method === 'editMessageText');
  assert.ok(edit, 'plan message should be edited');
  assert.match(edit.payload.text, /Onaylandı · TUI/);
  assert.equal(edit.payload.reply_markup, undefined); // keyboard removed
});

test('empty plan shows the questions and a close button instead of "code"', async () => {
  const { sm, bridge, api } = setup();
  sm.transition('submit', { prompt: 'deneme' });
  sm.transition('planReady', { plan: { summary: 's', files_to_modify: [], dependencies: [], risks: [], questions: ['Ne yapalım?'] } });
  sm.transition('noop', {}, 'tui');
  await bridge.flush();
  const plan = sent().find((c) => /Plan hazır/.test(c.payload.text));
  assert.match(plan.payload.text, /Şefin soruları[\s\S]*Ne yapalım\?/);
  assert.equal(plan.payload.reply_markup.inline_keyboard[0][0].text, '✅ Tamam');
  const edit = api.find((c) => c.method === 'editMessageText');
  assert.match(edit.payload.text, /Değişiklik yok/);
});

test('build result lists files with line counts, offers undo and the diff as a file', async () => {
  const { sm, bridge, bot, api } = setup();
  sm.transition('submit', { prompt: 'x' });
  sm.transition('planReady', { plan: { summary: 's', files_to_modify: ['a.js'], dependencies: [], risks: [] } });
  sm.transition('approve', {});
  sm.update({ tasks: [{ file_path: 'a.js', status: 'running', worker: 'codex' }] });
  await settle(bridge);
  // Sent or edited, the card ends up showing the task with its worker.
  assert.match(api.filter((c) => /Kodlanıyor/.test(c.payload.text || '')).at(-1).payload.text, /Kodlanıyor<\/b> · 0\/1[\s\S]*⏳ <code>a\.js<\/code> · Codex/);

  sm.update({ tasks: [{ file_path: 'a.js', status: 'done', worker: 'codex' }] });
  sm.transition('buildDone', { snapshotSha: 'abc', diff: { files: [{ status: 'M', path: 'a.js', added: 12, removed: 3 }] } });
  await bridge.flush();
  const done = sent().at(-1);
  assert.match(done.payload.text, /Kodlandı<\/b> · 1 dosya · \+12 −3/);
  assert.match(done.payload.text, /🟡 <code>a\.js<\/code> <i>\+12 −3<\/i>/);
  assert.deepEqual(buttonsOf(done), [`rollback:${sm.turnId}`, `diff:${sm.turnId}`]);

  await bot.handleUpdate(buttonUpdate(OWNER, `diff:${sm.turnId}`));
  await bridge.flush();
  const doc = api.find((c) => c.method === 'sendDocument');
  assert.ok(doc, 'diff should be sent as a document');
});

test('/stop stops the run and the live card says so', async () => {
  const { sm, bot, bridge, api } = setup();
  sm.transition('submit', { prompt: 'x' });
  sm.emit('triage', { kind: 'question', turnId: sm.turnId });
  await bot.handleUpdate(textUpdate(OWNER, '/stop'));
  await bridge.flush();
  assert.equal(sm.status, 'ABORTED');
  assert.match(api.filter((c) => c.method === 'editMessageText').at(-1).payload.text, /Soru<\/b> · durduruldu/);
  assert.match(sent().at(-1).payload.text, /Durduruldu<\/b> · Telegram/);
});

test('/status is a card with shortcuts; the mode button cycles in place', async () => {
  const { sm, bot, bridge, api } = setup();
  await bot.handleUpdate(textUpdate(OWNER, '/status'));
  await bridge.flush();
  const card = sent().at(-1);
  assert.match(card.payload.text, /🐺 <b>demo<\/b> · hazır/);
  assert.match(card.payload.text, /Mod: <b>onaylı<\/b>/);
  assert.deepEqual(buttonsOf(card), ['st:mode', 'st:new', 'st:compact']);

  await bot.handleUpdate(buttonUpdate(OWNER, 'st:mode', card.payload.message_id ?? 100));
  await bridge.flush();
  assert.equal(sm.permissionMode, 'auto');
  const edit = api.filter((c) => c.method === 'editMessageText').at(-1);
  assert.match(edit.payload.text, /Mod: <b>otomatik<\/b>/);
});

test('/mode without an argument offers the three modes', async () => {
  const { bot, bridge } = setup();
  await bot.handleUpdate(textUpdate(OWNER, '/mode'));
  await bridge.flush();
  const msg = sent().at(-1);
  assert.deepEqual(buttonsOf(msg), ['mode:default', 'mode:auto', 'mode:plan']);
  assert.equal(msg.payload.reply_markup.inline_keyboard[0][0].text, '✓ onaylı');
});

test('RC off: says goodbye, detaches and stops sending', async () => {
  const { sm, bridge, api } = setup();
  bridge.status = 'on';
  const res = await rcCommand(bridge, 'off');
  assert.ok(res.ok);
  assert.equal(res.on, false);
  assert.equal(bridge.status, 'off');
  assert.equal(bridge.bot, null);
  assert.match(api.at(-1).payload.text, /Uzaktan kontrol kapatıldı/);
  const before = api.length;
  sm.transition('submit', { prompt: 'x' });
  await bridge.flush();
  assert.equal(api.length, before); // no notifications while RC is off
});

test('RC on without Telegram config explains what is missing', async () => {
  const sm = new StateMachine({ chief: 'claude' });
  const bridge = new TelegramBridge({ token: null, allowedUserId: null, sm, orch: {} });
  const res = await rcCommand(bridge);
  assert.equal(res.ok, false);
  assert.match(res.reason, /TELEGRAM_BOT_TOKEN/);
  assert.equal((await rcCommand(null)).ok, false);
});

test('chat is answered quietly; a question gets the live card and a rendered result', async () => {
  const { sm, bridge, bot } = setup();
  await bot.handleUpdate(textUpdate(OWNER, 'selam'));
  sm.emit('triage', { kind: 'chat', turnId: sm.turnId });
  sm.transition('answer', { answer: 'Merhaba <3' });
  await bridge.flush();
  assert.deepEqual(sent().map((c) => c.payload.text), ['Merhaba &lt;3']); // no card, just the reply

  sm.transition('submit', { prompt: "y' = y ise?" }, 'tui');
  sm.emit('triage', { kind: 'question', turnId: sm.turnId });
  await bridge.flush(); // a turn that ends before its card is out gets no card at all
  sm.transition('answer', { answer: '**Çözüm:** `y = e^x`', kind: 'question', answeredBy: 4 });
  await bridge.flush();
  const [card, result] = sent().slice(-2).map((c) => c.payload.text);
  assert.match(card, /🤔 <b>Soru<\/b>[\s\S]*<blockquote>🖥 y' = y ise\?<\/blockquote>/);
  assert.equal(result, "<blockquote>🖥 y' = y ise?</blockquote>\n🧠 <b>Sonuç</b> · 4 ajan\n\n<b>Çözüm:</b> <code>y = e^x</code>");
});

test('HTML that Telegram refuses is sent again as plain text', async () => {
  const { sm, bridge } = setup();
  failHtml = true;
  sm.transition('submit', { prompt: 'x' });
  sm.transition('answer', { answer: '**kalın** & düz' });
  await bridge.flush();
  const msg = sent().at(-1);
  assert.equal(msg.payload.parse_mode, undefined);
  assert.equal(msg.payload.text, 'kalın & düz');
});

test('planCard escapes HTML and stays under Telegram limits', () => {
  const long = 'x'.repeat(10_000);
  const text = planCard({ summary: long, files_to_modify: [], dependencies: [], risks: [] }, '<script>');
  assert.ok(text.length < 4096);
  assert.match(text, /&lt;script&gt;/);
  assert.equal(esc('a&b'), 'a&amp;b');
});

test('mdToHtml turns agent Markdown into Telegram HTML', () => {
  const md = ['# Başlık', '', 'Bir **kalın**, *eğik*, ~~eski~~ ve `kod <x>`.', '- madde', '> alıntı', '', '```js', 'if (a < b) {}', '```', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', '[link](https://ornek.com)'].join('\n');
  const html = mdToHtml(md);
  assert.match(html, /^<b>Başlık<\/b>/);
  assert.match(html, /<b>kalın<\/b>, <i>eğik<\/i>, <s>eski<\/s> ve <code>kod &lt;x&gt;<\/code>/);
  assert.match(html, /• madde/);
  assert.match(html, /<blockquote>alıntı<\/blockquote>/);
  assert.match(html, /<pre><code class="language-js">if \(a &lt; b\) \{\}<\/code><\/pre>/);
  assert.match(html, /<pre>\| a \| b \|\n\|---\|---\|\n\| 1 \| 2 \|<\/pre>/);
  assert.match(html, /<a href="https:\/\/ornek\.com">link<\/a>/);
  assert.equal(plain('<b>a</b> &amp; &lt;b&gt;'), 'a & <b>');
});

test('splitMarkdown keeps pieces small and code fences balanced', () => {
  const code = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n');
  const parts = splitMarkdown(`Giriş\n\n\`\`\`py\n${code}\n\`\`\`\n\nSon`, 3300);
  assert.ok(parts.length > 1);
  for (const p of parts) {
    assert.ok(p.length <= 3400);
    assert.equal((p.match(/^```/gm) || []).length % 2, 0, 'every piece closes its fences');
  }
  assert.ok(parts[1].startsWith('```py'));
});

test('clarifying questions are buttons; multi-select ticks, then Tamam; typed text answers too', async () => {
  const { sm, bridge, bot, api, calls } = setup();
  sm.transition('submit', { prompt: 'site yap, önce sor' });
  sm.emit('triage', { kind: 'clarify', turnId: sm.turnId });
  const questions = [
    { question: 'Hangi tema?', header: 'Tema', options: [{ label: 'Koyu', description: 'koyu arka plan' }, { label: 'Açık', description: '' }], multiSelect: false },
    { question: 'Hangi sayfalar?', header: 'Sayfalar', options: [{ label: 'Blog' }, { label: 'Projeler' }, { label: 'İletişim' }], multiSelect: true },
    { question: 'Alan adı?', header: 'Alan', options: [{ label: 'Var' }, { label: 'Yok' }], multiSelect: false },
  ];
  sm.transition('clarify', { questions, answers: [] });
  await bridge.flush();
  const card = sent().at(-1);
  assert.match(card.payload.text, /Şefin sorusu<\/b> · 1\/3/);
  assert.match(card.payload.text, /<b>Hangi tema\?<\/b>/);
  assert.match(card.payload.text, /<b>Koyu<\/b> · koyu arka plan/);
  const sid = sm.turnId;
  assert.deepEqual(buttonsOf(card), [`qa:${sid}:0:0`, `qa:${sid}:0:1`, `cancel:${sid}`]);

  await bot.handleUpdate(buttonUpdate(OWNER, `qa:${sid}:0:0`));
  await bridge.flush();
  assert.deepEqual(calls.orch.at(-1), ['answerQuestion', 0, 'Koyu', 'telegram']);
  let edit = api.filter((c) => c.method === 'editMessageText').at(-1);
  assert.match(edit.payload.text, /☑️ Tema: <i>Koyu<\/i>[\s\S]*Hangi sayfalar\?/);
  assert.deepEqual(buttonsOf(edit), [`qa:${sid}:1:0`, `qa:${sid}:1:1`, `qa:${sid}:1:2`, `qd:${sid}:1`, `cancel:${sid}`]);

  await bot.handleUpdate(buttonUpdate(OWNER, `qa:${sid}:0:1`)); // already answered
  await bot.handleUpdate(buttonUpdate(OWNER, `qd:${sid}:1`)); // nothing ticked yet
  await bot.handleUpdate(buttonUpdate(OWNER, `qa:${sid}:1:0`));
  await bot.handleUpdate(buttonUpdate(OWNER, `qa:${sid}:1:2`));
  await bridge.flush();
  edit = api.filter((c) => c.method === 'editMessageText').at(-1);
  assert.equal(edit.payload.reply_markup.inline_keyboard[0][0].text, '☑️ Blog');
  assert.equal(edit.payload.reply_markup.inline_keyboard[1][0].text, '⬜ Projeler');
  await bot.handleUpdate(buttonUpdate(OWNER, `qd:${sid}:1`));
  assert.deepEqual(calls.orch.filter((c) => c[0] === 'answerQuestion').length, 2);
  assert.deepEqual(calls.orch.at(-1), ['answerQuestion', 1, ['Blog', 'İletişim'], 'telegram']);

  await bot.handleUpdate(textUpdate(OWNER, '2')); // a number picks that option
  await bridge.flush();
  assert.deepEqual(calls.orch.at(-1), ['answerQuestion', 2, 'Yok', 'telegram']);
  assert.equal(sm.status, 'DEBATING');
  edit = api.filter((c) => c.method === 'editMessageText').at(-1);
  assert.match(edit.payload.text, /Sorular yanıtlandı[\s\S]*Hangi sayfalar\?\n  → <b>Blog, İletişim<\/b>/);
  assert.deepEqual(edit.payload.reply_markup.inline_keyboard, []);
});
