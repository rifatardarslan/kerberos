import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { Telegraf, Telegram, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { HubLink, projectTopics, rememberTopic, topicsFile } from './hub.js';
import { typedAnswer } from '../core/protocol.js';
import { t, tn } from '../i18n/index.js';
import { commandMenu, MODE_TEXT, SOURCE_TEXT, STATUS_TEXT, answersCard, doneCard, questionCard, esc, helpText, mdToHtml, plain, planCard, progressCard, splitMarkdown, statusCard } from './format.js';

export { esc } from './format.js';

const TRAIL_MAX = 500; // message ids kept per session for /clear
const EDIT_EVERY = 2500; // the live card is edited at most this often…
const TICK = 10_000; // …and at least this often, so the clock moves
const MODES = ['default', 'auto', 'plan'];
const BAD_HTML = /can't parse entities|unsupported start tag|can't find end tag/i;
const GONE = /thread not found|topic.*(closed|deleted|not found)/i;
const UNCHANGED = /message is not modified/i;

/** `/rc`, `/rc on`, `/rc off` shared by the TUI and the headless prompt. */
export async function rcCommand(telegram, arg = '') {
  if (!telegram) return { ok: false, reason: t('Telegram is disabled (--no-telegram)') };
  const a = arg.trim().toLowerCase();
  const want = a === 'on' || a === 'aç' ? true : a === 'off' || a === 'kapat' ? false : !telegram.active;
  const res = await (want ? telegram.start() : telegram.stop());
  return { ...res, on: want, topic: want && res.ok ? telegram.topicLabel : undefined };
}

const button = (text, data) => Markup.button.callback(text, data);

/**
 * Telegram remote control. Only TELEGRAM_ALLOWED_USER_ID is served; everyone else is
 * silently ignored. Each turn gets one live card that is edited in place (who is
 * working, how long), followed by the result: an answer, a plan with buttons or the
 * list of changed files.
 *
 * Each project folder gets one forum topic in the bot chat (Bot API 9.4, "Threaded
 * Mode" in BotFather); new sessions in that folder reuse it, a second Kerberos running
 * in the same folder at the same time gets its own. Without topic mode everything
 * goes to the single chat as before.
 * Polling is shared between Kerberos processes through the hub (hub.js).
 */
export class TelegramBridge extends EventEmitter {
  constructor({ token, allowedUserId, sm, orch, workspace = null, root = '', logger = () => {}, hub = {} }) {
    super();
    this.root = root;
    this.workspace = workspace;
    this.hubOptions = hub;
    this.session = null;
    this.sessions = null; // SessionController, set by it
    this.threadId = null;
    this.topics = false;
    this.link = null;
    this.token = token;
    this.allowedUserId = allowedUserId;
    this.sm = sm;
    this.orch = orch;
    this.log = logger;
    this.status = 'off';
    this.bot = null;
    this.planMsg = null; // { id, text }
    this.doneMsg = null;
    this.askMsg = null; // the open clarifying question
    this.askIdx = -1;
    this.picked = new Set(); // ticked options of a multi-select question
    this.progress = null; // the live card of the running turn
    this.turnSource = null;
    this.turnStart = 0;
    this.replanning = false;
    this.queue = Promise.resolve();
    this.onState = this.onState.bind(this);
    this.onFailover = this.onFailover.bind(this);
    this.onTriage = this.onTriage.bind(this);
    this.onChunk = this.onChunk.bind(this);
  }

  get enabled() {
    return Boolean(this.token && this.allowedUserId);
  }

  #setStatus(s) {
    this.status = s;
    this.emit('status', s);
  }

  get active() {
    return this.status === 'on' || this.status === 'connecting';
  }

  /** 'hub' (this process polls Telegram), 'client' (updates come via the hub) or null. */
  get role() {
    return this.link?.role ?? null;
  }

  /** /doctor: can we reach the bot, and is topic mode on? */
  async probe() {
    if (!this.enabled) return { ok: false, reason: t('not configured') };
    try {
      const me = await (this.bot?.telegram || new Telegram(this.token)).getMe();
      return { ok: true, username: me.username, topics: Boolean(me.has_topics_enabled) };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  /** Follow the active session: its topic, title and routing entry in the hub. */
  bindSession(session) {
    if (this.session === session) return;
    const switched = Boolean(this.session);
    this.session = session;
    if (!this.active || !switched) return;
    // /new or /resume: same folder, same topic; just mark where the new session starts.
    this.planMsg = null;
    this.doneMsg = null;
    this.askMsg = null;
    this.#enqueue(async (tg) => {
      if (this.threadId) session.touch({ telegramThreadId: this.threadId });
      this.#rememberTopic();
      this.link?.register(this.#memberInfo());
      return this.#post(tg, this.#sessionBanner());
    });
  }

  #sessionBanner() {
    const s = this.session;
    if (!s) return `📁 <b>${esc(this.#folder())}</b>`;
    if (!s.turns.length) return `🆕 <b>${t('New chat')}</b> · <code>${esc(s.shortId)}</code>`;
    return `↩️ <b>${t('Chat continues')}</b> · <code>${esc(s.shortId)}</code> · ${tn(s.turns.length, '{n} turn', '{n} turns')}${s.title ? `\n<i>${esc(s.title)}</i>` : ''}`;
  }

  /** Session renamed or titled by its first task: rename the topic too. */
  retitle() {
    if (!this.active) return;
    this.#enqueue(async (tg) => {
      this.link?.register(this.#memberInfo());
      if (!this.topics || !this.threadId) return;
      const name = this.#topicName();
      if (name === this.topicName) return;
      await tg.editForumTopic(this.allowedUserId, this.threadId, { name });
      this.topicName = name;
      this.#rememberTopic();
    });
  }

  /** Name of this folder's topic; false when the bot has no topic mode. */
  get topicLabel() {
    return this.topics ? this.topicName || this.#topicName() : false;
  }

  #folder() {
    return path.basename(this.root) || this.root;
  }

  #topicName() {
    const title = this.session?.title?.replace(/\s+/g, ' ');
    return (title ? `📁 ${this.#folder()} · ${title}` : `📁 ${this.#folder()}`).slice(0, 128);
  }

  #memberInfo() {
    return { sessionId: this.session?.id ?? null, threadId: this.threadId, root: this.root, title: this.session?.title ?? null, status: this.#statusLabel() };
  }

  get topicsPath() {
    return this.hubOptions.topicsPath || topicsFile(this.token);
  }

  #rememberTopic() {
    if (!this.threadId) return;
    try {
      rememberTopic(this.topicsPath, this.threadId, { sessionId: this.session?.id, root: this.root, title: this.session?.title ?? null, name: this.topicName ?? null });
    } catch {
      // only used to answer in topics of closed sessions
    }
  }

  /**
   * Pick this folder's topic: the session's own (on resume), else the folder's most
   * recent one, unless another running Kerberos already uses it. Otherwise (or when the
   * user deleted it, `force`) create one.
   */
  async #ensureTopic(tg, { force = false } = {}) {
    if (!this.topics || !this.session) return;
    if (!force) {
      const busy = new Set((await this.link?.busyThreads()) || []);
      const known = projectTopics(this.topicsPath, this.root);
      const own = this.session.meta.telegramThreadId;
      const pick = [own, ...known.map((t) => t.threadId)].find((id) => id && !busy.has(id));
      if (pick) {
        this.threadId = pick;
        this.topicName = known.find((t) => t.threadId === pick)?.name ?? null;
        if (own !== pick) await this.session.save({ telegramThreadId: pick });
        this.#rememberTopic();
        return;
      }
    }
    const name = this.#topicName();
    const topic = await tg.createForumTopic(this.allowedUserId, name);
    this.threadId = topic.message_thread_id;
    this.topicName = name;
    await this.session.save({ telegramThreadId: this.threadId });
    this.#rememberTopic();
  }

  /** Enable remote control: connect, start polling and announce on the phone. */
  async start() {
    if (!this.enabled) return { ok: false, reason: t('Telegram is not configured (.env: TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_ID)') };
    if (this.active) return { ok: true };
    this.#setStatus('connecting');
    const bot = this.createBot();

    const link = new HubLink({ token: this.token, allowedUserId: this.allowedUserId, log: this.log, ...this.hubOptions });
    try {
      const me = await bot.telegram.getMe();
      bot.botInfo = me;
      this.username = me.username;
      this.topics = Boolean(me.has_topics_enabled);
      link.topics = this.topics;
      if (this.bot !== bot) return { ok: false, reason: t('Cancelled') }; // stopped while connecting
      if (!this.topics) this.log(t('Telegram topics are off: turn on BotFather Mini App (Open) → My bots → your bot → Bot Settings → Threads Settings → Threaded Mode and every project gets its own topic. One chat for now.'), 'warn');
      this.threadId = null;
      this.link = link;
      link.on('update', (u) => this.bot === bot && bot.handleUpdate(u).catch((err) => this.log(`${t('Telegram error')}: ${err.message}`, 'error')));
      // Join first: picking the folder's topic needs to know which ones are in use.
      await link.join(this.#memberInfo());
      await this.#ensureTopic(bot.telegram);
      link.register(this.#memberInfo());
    } catch (err) {
      await link.leave().catch(() => {});
      if (this.link === link) this.link = null;
      if (this.bot !== bot) return { ok: false, reason: t('Cancelled') };
      this.bot = null;
      this.#setStatus('error');
      this.log(`${t('Could not connect to Telegram')}: ${err.message}`, 'error');
      return { ok: false, reason: err.message };
    }
    if (this.bot !== bot) {
      await link.leave().catch(() => {});
      return { ok: false, reason: t('Cancelled') };
    }

    this.attach();
    this.#setStatus('on');
    this.log(`${t('RC on')}: @${this.username}${this.topics ? ` · ${t('Telegram topic')}: ${this.topicName || this.#topicName()}` : ''}`);
    // The "/" menu in the chat; harmless to repeat from every Kerberos.
    bot.telegram.setMyCommands(commandMenu(), { scope: { type: 'chat', chat_id: this.allowedUserId } }).catch(() => {});
    this.#send(`🟢 <b>${t('Kerberos connected')}</b>${this.topics ? '' : ` · 📁 ${esc(this.#folder())}`}\n${this.#sessionBanner()}`);
    return { ok: true };
  }

  /** Disable remote control. Sends a goodbye first (bounded wait) unless `notify` is false. */
  async stop({ notify = true, exiting = false } = {}) {
    const bot = this.bot;
    const link = this.link;
    const wasOn = this.status === 'on';
    this.detach();
    this.#endProgress();
    this.bot = null;
    this.link = null;
    this.planMsg = null;
    this.doneMsg = null;
    this.askMsg = null;
    this.#setStatus('off');
    if (!bot) return { ok: true };
    if (notify && wasOn) {
      const resume = this.session ? `\n${t('To continue')}: <code>kerberos --resume ${esc(this.session.shortId)}</code>` : '';
      const text = exiting ? `⚫ <b>${t('Kerberos closed')}</b>${resume}` : `⚫ <b>${t('Remote control turned off')}</b>`;
      const bye = this.#post(bot.telegram, text).catch(() => {});
      await Promise.race([bye, new Promise((r) => setTimeout(r, 1500))]);
    }
    // Hand polling over to another Kerberos; bounded so exiting never hangs.
    if (link) await Promise.race([link.leave().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
    this.log(t(exiting ? 'RC off (Kerberos exited)' : 'RC off'));
    return { ok: true };
  }

  toggle() {
    return this.active ? this.stop() : this.start();
  }

  /** Subscribe to state changes (milestone notifications). */
  attach() {
    this.detach();
    this.sm.on('state', this.onState);
    this.sm.on('failover', this.onFailover);
    this.sm.on('triage', this.onTriage);
    this.sm.on('chunk', this.onChunk);
  }

  detach() {
    this.sm.off('state', this.onState);
    this.sm.off('failover', this.onFailover);
    this.sm.off('triage', this.onTriage);
    this.sm.off('chunk', this.onChunk);
  }

  /** Build the Telegraf instance with whitelist, commands and button handlers. */
  createBot() {
    const bot = (this.bot = new Telegraf(this.token, { handlerTimeout: 60_000 }));

    // Whitelist: drop everything not from the allowed user, without replying.
    bot.use((ctx, next) => (ctx.from?.id === this.allowedUserId ? next() : undefined));
    bot.use((ctx, next) => {
      if (ctx.message) this.#track(ctx.message.message_id);
      return next();
    });

    // Replies go through #send so they land in this session's topic.
    bot.start(() => this.#send(helpText({ topics: this.topics })));
    bot.command('help', () => this.#send(helpText({ topics: this.topics })));
    bot.command(['status', 'sessions'], () => this.#sendStatus());
    bot.command(['stop', 'abort'], () => this.#abort());
    bot.command('plan', (ctx) => this.#submit(ctx.payload, 'task'));
    bot.command('ask', (ctx) => this.#submit(ctx.payload, 'question'));
    bot.command('approve', () => this.#reply(this.orch.approve('telegram')));
    bot.command('cancel', () => this.#reply(this.orch.cancel('telegram')));
    bot.command(['undo', 'rollback'], async () => this.#reply(await this.orch.rollback('telegram')));
    bot.command('new', async () => this.#newSession());
    bot.command('clear', async () => this.#clear());
    bot.command('compact', async (ctx) => this.#compact(ctx.payload));
    bot.command('mode', (ctx) => {
      const arg = ctx.payload.trim().toLowerCase();
      if (!arg) return this.#send(`⚙️ <b>${t('Permission mode')}</b>`, this.#modeKeyboard());
      const res = this.orch.setPermissionMode(arg);
      return this.#send(res.ok ? this.#modeLine() : `ℹ️ ${esc(res.reason)}`);
    });

    bot.on(message('text'), (ctx) => {
      const text = ctx.message.text.trim();
      if (text.startsWith('/')) return this.#send(`🤷 ${t('Unknown command')} · /help`);
      if (this.sm.status === 'AWAITING_ANSWERS') {
        const i = this.orch.openQuestion;
        const res = this.orch.answerQuestion(i, typedAnswer(this.sm.questions?.[i], text), 'telegram');
        return res.ok ? undefined : this.#send(`ℹ️ ${esc(res.reason)}`);
      }
      if (this.sm.status === 'AWAITING_APPROVAL') {
        const res = this.orch.replan(text, 'telegram');
        return res.ok ? undefined : this.#send(`ℹ️ ${esc(res.reason)}`);
      }
      return this.#submit(text);
    });

    // Buttons tied to one turn: an older turn's buttons only get their keyboard removed.
    bot.action(/^(approve|auto|replan|cancel|rollback|accept|diff):(\w+)$/, async (ctx) => {
      const [, action, sid] = ctx.match;
      if (sid !== this.sm.turnId) {
        await ctx.answerCbQuery('Bu buton eski bir tura ait.').catch(() => {});
        await ctx.editMessageReplyMarkup(undefined).catch(() => {});
        return;
      }
      let res;
      if (action === 'approve') res = this.orch.approve('telegram');
      else if (action === 'auto') {
        this.orch.setPermissionMode('auto');
        res = this.orch.approve('telegram');
      } else if (action === 'replan') res = this.orch.replan('', 'telegram');
      else if (action === 'cancel') res = this.orch.cancel('telegram');
      else if (action === 'accept') res = this.orch.accept('telegram');
      else if (action === 'diff') res = await this.#sendDiff();
      else res = await this.orch.rollback('telegram');
      await ctx.answerCbQuery(res.ok ? res.toast || '✓' : res.reason.slice(0, 190)).catch(() => {});
    });
    // Clarifying questions: qa = pick (toggle when multi-select), qd = done (multi-select).
    bot.action(/^q([ad]):(\w+):(\d+)(?::(\d+))?$/, async (ctx) => {
      const [, act, sid, qi, oi] = ctx.match;
      const i = Number(qi);
      if (sid !== this.sm.turnId || i !== this.orch.openQuestion) {
        await ctx.answerCbQuery(t('This question is no longer open.')).catch(() => {});
        return;
      }
      const q = this.sm.questions[i];
      let res = { ok: true };
      if (act === 'a' && !q.multiSelect) res = this.orch.answerQuestion(i, q.options[Number(oi)]?.label, 'telegram');
      else if (act === 'a') {
        const k = Number(oi);
        if (this.picked.has(k)) this.picked.delete(k);
        else this.picked.add(k);
        this.#showQuestion(true);
      } else if (!this.picked.size) res = { ok: false, reason: t('Pick at least one option first') };
      else res = this.orch.answerQuestion(i, q.options.filter((_, k) => this.picked.has(k)).map((o) => o.label), 'telegram');
      await ctx.answerCbQuery(res.ok ? '✓' : res.reason.slice(0, 190)).catch(() => {});
    });
    bot.action(/^stop:\w*$/, async (ctx) => {
      const res = this.orch.abort('telegram');
      await ctx.answerCbQuery(res.ok ? `⏹ ${t('Stopped')}` : res.reason.slice(0, 190)).catch(() => {});
    });
    bot.action(/^mode:(\w+)$/, async (ctx) => {
      const res = this.orch.setPermissionMode(ctx.match[1]);
      await ctx.answerCbQuery(res.ok ? `${t('Mode')}: ${MODE_TEXT[ctx.match[1]]}` : res.reason.slice(0, 190)).catch(() => {});
      if (res.ok) await ctx.editMessageText(this.#modeLine(), { parse_mode: 'HTML', ...this.#modeKeyboard() }).catch(() => {});
    });
    // The /status card's shortcuts.
    bot.action(/^st:(\w+)$/, async (ctx) => {
      const act = ctx.match[1];
      let res = { ok: true };
      if (act === 'mode') res = this.orch.cyclePermissionMode();
      else if (act === 'new') res = (await this.sessions?.newSession()) || { ok: false, reason: t('Sessions are unavailable') };
      else if (act === 'compact') this.#compact('');
      else if (act === 'stop') res = this.orch.abort('telegram');
      else if (act === 'undo') res = await this.orch.rollback('telegram');
      await ctx.answerCbQuery(res.ok ? (act === 'mode' ? `${t('Mode')}: ${MODE_TEXT[this.sm.permissionMode]}` : '✓') : res.reason.slice(0, 190)).catch(() => {});
      const card = this.#statusCard();
      await ctx.editMessageText(card.text, { parse_mode: 'HTML', ...card.keyboard }).catch(() => {});
    });

    bot.catch((err) => this.log(`${t('Telegram error')}: ${err.message}`, 'error'));
    return bot;
  }

  /** Resolves once every queued outbound call has run (used by tests). */
  flush() {
    return this.queue;
  }

  // ------------------------------------------------------------------ outbound

  /** Queue an outbound call; `fn(tg)` is skipped if RC was turned off meanwhile. */
  #enqueue(fn) {
    this.queue = this.queue
      .then(() => {
        const tg = this.bot?.telegram;
        return tg ? fn(tg) : null;
      })
      .catch((err) => this.log(`${t('Telegram send error')}: ${err.message}`, 'warn'));
    return this.queue;
  }

  /** Remember a message of this session so /clear can delete it. */
  #track(id) {
    const s = this.session;
    if (!s || !id) return;
    const trail = (s.meta.telegramMessages ||= []);
    trail.push(id);
    if (trail.length > TRAIL_MAX) trail.splice(0, trail.length - TRAIL_MAX);
    s.touch({});
  }

  get #where() {
    return this.threadId ? { message_thread_id: this.threadId } : {};
  }

  /**
   * Send into this session's topic. A topic the user deleted is created again once;
   * HTML that Telegram refuses (agent text can be odd) goes out as plain text.
   */
  async #post(tg, text, extra = {}) {
    const go = async (body, mode) => {
      const msg = await tg.sendMessage(this.allowedUserId, body, { ...(mode ? { parse_mode: mode } : {}), link_preview_options: { is_disabled: true }, ...this.#where, ...extra });
      this.#track(msg?.message_id);
      return msg;
    };
    const send = async () => {
      try {
        return await go(text, 'HTML');
      } catch (err) {
        if (!BAD_HTML.test(err.message)) throw err;
        this.log(`Telegram rejected the HTML, sending plain text: ${err.message}`, 'debug');
        return go(plain(text));
      }
    };
    try {
      return await send();
    } catch (err) {
      if (!this.threadId || !GONE.test(err.message)) throw err;
      await this.#ensureTopic(tg, { force: true });
      this.link?.register(this.#memberInfo());
      return send();
    }
  }

  #send(text, extra = {}) {
    return this.#enqueue((tg) => this.#post(tg, text, extra));
  }

  /** The site check's final screenshots as one album (desktop and phone). */
  #sendShots(preview) {
    const shots = preview.shots.filter((s) => fs.existsSync(s.file)).slice(0, 6);
    if (!shots.length) return;
    const caption = `🌐 ${t('Site check')} · ${preview.problems ? tn(preview.problems, '{n} problem left', '{n} problems left') : t('no automatic problems')}`;
    this.#enqueue(async (tg) => {
      const media = shots.map((s, i) => ({ type: 'photo', media: { source: fs.createReadStream(s.file) }, ...(i === 0 ? { caption } : {}) }));
      const msgs = await tg.sendMediaGroup(this.allowedUserId, media, this.#where).catch((err) => this.log(`${t('Telegram send error')}: ${err.message}`, 'warn'));
      for (const m of msgs || []) this.#track(m?.message_id);
    });
  }

  /** Agent Markdown as Telegram HTML, split over as many messages as needed. */
  #sendMarkdown(md, head = '') {
    const parts = splitMarkdown(md);
    if (!parts.length) parts.push('…');
    parts.forEach((part, i) => this.#send(`${i === 0 ? head : ''}${mdToHtml(part)}`));
  }

  #edit(tg, id, text, extra = {}) {
    return tg.editMessageText(this.allowedUserId, id, undefined, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra }).catch((err) => {
      if (UNCHANGED.test(err.message)) return null;
      if (BAD_HTML.test(err.message)) return tg.editMessageText(this.allowedUserId, id, undefined, plain(text), extra);
      throw err;
    });
  }

  /**
   * Replace a remembered message's keyboard with a status footer (keeps the text).
   * The reference is read inside the queue, so a message that is still being sent
   * is edited correctly once it exists.
   */
  #close(key, footer, fallback) {
    return this.#enqueue(async (tg) => {
      const ref = this[key];
      this[key] = null;
      if (!ref) return fallback ? this.#post(tg, fallback) : null;
      const text = `${ref.text}\n\n${footer}`;
      return this.#edit(tg, ref.id, text.length > 4000 ? `${ref.text.slice(0, 3900 - footer.length)}…\n\n${footer}` : text);
    });
  }

  /** Send and remember the message under `key` (set before any later queued step runs). */
  #sendKept(key, text, extra) {
    return this.#enqueue(async (tg) => {
      const msg = await this.#post(tg, text, extra);
      this[key] = { id: msg.message_id, text };
      return msg;
    });
  }

  // ------------------------------------------------------------------ live card

  /** One message per turn, edited as agents start and finish. */
  #startProgress(kind) {
    this.#endProgress();
    const p = { kind, replan: this.replanning, startedAt: kind === 'build' ? Date.now() : this.turnStart || Date.now(), phase: null, agents: [], tasks: [], msg: null, last: 0, timer: null };
    this.replanning = false;
    this.progress = p;
    p.tick = setInterval(() => this.#renderProgress(), TICK);
    p.tick.unref?.();
    const prompt = this.turnSource === 'tui' && kind !== 'build' ? `\n<blockquote>🖥 ${esc(String(this.sm.prompt || '').slice(0, 300))}</blockquote>` : '';
    this.#enqueue(async (tg) => {
      if (this.progress !== p) return;
      const text = progressCard(p);
      p.msg = await this.#post(tg, text + prompt, this.#stopKeyboard());
      p.prompt = prompt;
      p.text = text;
    });
    return p;
  }

  #stopKeyboard() {
    return Markup.inlineKeyboard([[button(`⏹ ${t('Stop')}`, `stop:${this.sm.turnId}`)]]);
  }

  #renderProgress() {
    const p = this.progress;
    if (!p || p.timer) return;
    p.timer = setTimeout(() => {
      p.timer = null;
      p.last = Date.now();
      this.#enqueue(async (tg) => {
        if (this.progress !== p || !p.msg) return;
        const text = progressCard(p);
        if (text === p.text) return;
        p.text = text;
        await this.#edit(tg, p.msg.message_id, text + p.prompt, this.#stopKeyboard());
      });
    }, Math.max(0, p.last + EDIT_EVERY - Date.now()));
    p.timer.unref?.();
  }

  /** Collapse the card to one line (`done`: what happened) and drop its button. */
  #endProgress(done) {
    const p = this.progress;
    if (!p) return;
    this.progress = null;
    clearInterval(p.tick);
    clearTimeout(p.timer);
    if (!done) return;
    p.done = done;
    const text = progressCard(p);
    this.#enqueue(async (tg) => {
      if (p.msg) await this.#edit(tg, p.msg.message_id, text + (p.prompt || ''));
    });
  }

  onChunk({ agent, label, step, kind, durationMs }) {
    const p = this.progress;
    if (!p || step === 'triage' || step === 'repair' || !['start', 'end', 'error'].includes(kind)) return;
    let a = p.agents.find((x) => x.id === agent);
    if (kind === 'start') {
      if (!a) p.agents.push((a = { id: agent, label }));
      Object.assign(a, { step, state: 'run', ms: 0 });
      p.phase = step;
    } else if (a) {
      a.state = kind === 'end' ? 'ok' : 'err';
      a.ms = durationMs || 0;
    }
    this.#renderProgress();
  }

  #taskRows(tasks = []) {
    return tasks.map((t) => ({ ...t, workerLabel: t.worker ? this.sm.agents[t.worker]?.label || t.worker : null }));
  }

  // ------------------------------------------------------------------ state

  onState(snap, { action, source }) {
    const by = SOURCE_TEXT[source] || source;
    const sid = snap.turnId;
    if (action !== 'update') this.link?.register({ status: this.#statusLabel() });
    switch (action) {
      case 'update':
        if (snap.status === 'AWAITING_ANSWERS') this.#showQuestion();
        if (this.progress?.kind === 'build') {
          this.progress.tasks = this.#taskRows(snap.tasks);
          this.#renderProgress();
        }
        break;
      case 'submit':
        // What follows depends on the chief's triage (onTriage); until then: "typing…".
        this.turnSource = source;
        this.turnStart = Date.now();
        this.#endProgress();
        this.#enqueue((tg) => {
          this.planMsg = null;
          this.doneMsg = null;
          return tg.sendChatAction(this.allowedUserId, 'typing', this.#where);
        });
        break;
      case 'answer': {
        const question = snap.kind === 'question';
        this.#endProgress(question ? t('answered') : null);
        const asked = this.turnSource === 'tui' ? `<blockquote>🖥 ${esc(String(snap.prompt || '').slice(0, 300))}</blockquote>\n` : '';
        const head = question ? `🧠 <b>${t('Result')}</b>${snap.answeredBy > 1 ? ` · ${t('{n} agents', { n: snap.answeredBy })}` : ''}\n\n` : '';
        this.#sendMarkdown(snap.answer, asked + head);
        break;
      }
      case 'clarify':
        this.askMsg = null;
        this.askIdx = -1;
        this.#showQuestion();
        break;
      case 'answered': {
        const text = answersCard(snap.questions, snap.answers);
        this.#enqueue(async (tg) => {
          const ref = this.askMsg;
          this.askMsg = null;
          if (ref) await this.#edit(tg, ref.id, text, { reply_markup: { inline_keyboard: [] } });
        });
        break;
      }
      case 'replan':
        this.replanning = true;
        this.turnStart = Date.now();
        this.#close('planMsg', `🔄 <i>${t('Replanning')} · ${esc(by)}</i>`);
        break;
      case 'planReady': {
        this.#endProgress(t('plan ready'));
        const empty = !snap.plan.files_to_modify?.length;
        const rows = empty
          ? [[button(`✅ ${t('OK')}`, `approve:${sid}`), button(`✖️ ${t('Cancel')}`, `cancel:${sid}`)]]
          : [[button(`🚀 ${t('Code it')}`, `approve:${sid}`), button(`✖️ ${t('Cancel')}`, `cancel:${sid}`)], ...(snap.permissionMode === 'auto' ? [] : [[button(`⏩ ${t("Code it · don't ask again")}`, `auto:${sid}`)]])];
        this.#sendKept('planMsg', planCard(snap.plan, snap.prompt, this.turnSource), Markup.inlineKeyboard(rows));
        break;
      }
      case 'approve':
        this.#close('planMsg', source === 'auto' ? `⏩ <i>${t('Approved automatically')}</i>` : `✅ <i>${t('Approved')} · ${esc(by)}</i>`);
        this.#startProgress('build');
        break;
      case 'noop':
        this.#close('planMsg', `☑️ <i>${t('No changes, turn closed')} · ${esc(by)}</i>`);
        break;
      case 'cancel':
        this.#close('askMsg', `✖️ <i>${t('Cancelled')} · ${esc(by)}</i>`);
        this.#close('planMsg', `✖️ <i>${t('Cancelled')} · ${esc(by)}</i>`);
        break;
      case 'buildDone': {
        const p = this.progress;
        const tasks = snap.tasks || [];
        this.#endProgress(p ? t('{done}/{n} files', { done: tasks.filter((task) => task.status === 'done').length, n: tasks.length }) : null);
        const row = snap.snapshotSha ? [button(`↩️ ${t('Undo')}`, `rollback:${sid}`), ...(this.workspace && snap.diff?.files?.length ? [button('📄 Diff', `diff:${sid}`)] : [])] : [];
        this.#sendKept('doneMsg', doneCard(snap.diff, tasks, snap.error, { review: snap.review, preview: snap.preview }), row.length ? Markup.inlineKeyboard([row]) : undefined);
        if (snap.preview?.shots?.length) this.#sendShots(snap.preview);
        break;
      }
      case 'rollback':
        this.#close('doneMsg', `↩️ <i>${t('Undone')} · ${esc(by)}</i>`, `↩️ ${t('Changes undone')} · ${esc(by)}`);
        break;
      case 'reset':
        this.#close('doneMsg', `👍 <i>${t('Accepted')} · ${esc(by)}</i>`);
        break;
      case 'abort': {
        this.#endProgress(t('stopped'));
        this.#close('askMsg', `⏹ <i>${t('Stopped')} · ${esc(by)}</i>`);
        this.#close('planMsg', `⏹ <i>${t('Stopped')} · ${esc(by)}</i>`);
        const kb = snap.snapshotSha ? Markup.inlineKeyboard([[button(`↩️ ${t('Undo')}`, `rollback:${sid}`)]]) : undefined;
        this.#sendKept('doneMsg', `⏹ <b>${t('Stopped')}</b> · ${esc(by)}`, kb);
        break;
      }
      case 'fail': {
        this.#endProgress(t('error'));
        const kb = snap.snapshotSha ? Markup.inlineKeyboard([[button(`↩️ ${t('Undo')}`, `rollback:${sid}`)]]) : undefined;
        this.#sendKept('doneMsg', `⚠️ <b>${t('Error')}</b>\n<pre>${esc(String(snap.error || '').slice(0, 1500))}</pre>`, kb);
        break;
      }
      default:
    }
  }

  /** The chief decided: chat stays quiet until the answer, questions and tasks get the live card. */
  onTriage({ kind }) {
    if (kind === 'chat') return;
    this.retitle();
    if (kind === 'clarify') return this.#endProgress();
    const p = this.#startProgress(kind);
    // The chief's first call (draft or own solution) is already behind us.
    const chief = this.sm.chief;
    p.agents.push({ id: chief, label: this.sm.agents[chief]?.label || chief, step: kind === 'question' ? 'solve' : 'draft', state: 'ok', ms: Date.now() - p.startedAt });
  }

  /**
   * Show the open clarifying question. The same message moves on to the next question
   * when one is answered (here or in the TUI); `force` redraws it (multi-select ticks).
   */
  #showQuestion(force = false) {
    const i = this.orch.openQuestion;
    if (i < 0 || (i === this.askIdx && !force)) return;
    if (i !== this.askIdx) this.picked = new Set();
    this.askIdx = i;
    const snap = this.sm.snapshot();
    const q = snap.questions[i];
    const sid = snap.turnId;
    const rows = q.options.map((o, k) => [button(`${q.multiSelect ? (this.picked.has(k) ? '☑️ ' : '⬜ ') : ''}${o.label}`.slice(0, 60), `qa:${sid}:${i}:${k}`)]);
    if (q.multiSelect) rows.push([button(`✅ ${t('Done')}`, `qd:${sid}:${i}`)]);
    rows.push([button(`✖️ ${t('Cancel')}`, `cancel:${sid}`)]);
    const text = questionCard({ questions: snap.questions, answers: snap.answers, index: i, prompt: snap.prompt, source: this.turnSource });
    const keyboard = Markup.inlineKeyboard(rows);
    this.#enqueue(async (tg) => {
      if (!this.askMsg) {
        const msg = await this.#post(tg, text, keyboard);
        this.askMsg = { id: msg.message_id, text };
        return;
      }
      this.askMsg.text = text;
      await this.#edit(tg, this.askMsg.id, text, keyboard);
    });
  }

  onFailover({ from, to, reason }) {
    const label = (id) => esc(this.sm.agents[id]?.label || id);
    this.#send(`🔁 ${t('Chief changed')}: <b>${label(from)}</b> → <b>${label(to)}</b> <i>(${esc(reason)})</i>`);
  }

  // ------------------------------------------------------------------ inbound helpers

  #submit(text, kind = null) {
    if (!text?.trim()) return this.#send(kind === 'question' ? `${t('Usage')}: <code>/ask ${t('question')}</code>` : `${t('Usage')}: <code>/plan ${t('what to do')}</code> · ${t('or just write it')}`);
    const res = this.orch.submit(text, 'telegram', kind ? { kind } : undefined);
    if (!res.ok) return this.#send(`ℹ️ ${esc(res.reason)}`);
  }

  /** Commands whose effect shows up elsewhere (an edited card) only speak on failure. */
  #reply(res) {
    return res.ok ? undefined : this.#send(`ℹ️ ${esc(res.reason)}`);
  }

  #abort() {
    const res = this.orch.abort('telegram');
    return res.ok ? undefined : this.#send(`ℹ️ ${esc(res.reason)}`);
  }

  async #compact(focus) {
    if (!this.sessions) return this.#send(`ℹ️ ${t('Sessions are unavailable')}`);
    this.#enqueue((tg) => tg.sendChatAction(this.allowedUserId, 'typing', this.#where));
    const res = await this.sessions.compact(focus);
    if (!res.ok) return this.#send(`ℹ️ ${esc(res.reason)}`);
    // Clip before escaping so the HTML stays well-formed under Telegram's limit.
    return this.#send(`🗜 <b>${t('History summarized')}</b> · ${tn(res.turns, '{n} turn', '{n} turns')}\n<blockquote expandable>${esc(res.summary.slice(0, 3000))}</blockquote>`);
  }

  /** Changes of the last build as a .diff file. */
  async #sendDiff() {
    const sha = this.sm.snapshotSha;
    if (!this.workspace || !sha) return { ok: false, reason: 'Diff yok' };
    const text = await this.workspace.diffText(sha, 20_000);
    if (!text.trim()) return { ok: false, reason: t('No changes') };
    await this.#enqueue(async (tg) => {
      const msg = await tg.sendDocument(this.allowedUserId, { source: Buffer.from(text, 'utf8'), filename: 'changes.diff' }, this.#where);
      this.#track(msg?.message_id);
    });
    return { ok: true, toast: `📄 ${t('Sent')}` };
  }

  /** Start a fresh conversation in the same topic (TUI follows via the controller). */
  async #newSession() {
    if (!this.sessions) return this.#send(`ℹ️ ${t('Sessions are unavailable')}`);
    const res = await this.sessions.newSession();
    if (!res.ok) return this.#send(`ℹ️ ${esc(res.reason)}`);
  }

  /**
   * Like Claude Code's /clear: new conversation, and this session's messages vanish
   * from the topic. Telegram only lets bots delete messages younger than 48 hours.
   */
  async #clear() {
    if (!this.sessions) return this.#send(`ℹ️ ${t('Sessions are unavailable')}`);
    if (this.sm.busy) return this.#send(`ℹ️ ${t("Can't clear while agents are running")} · /stop`);
    const ids = [...(this.session?.meta.telegramMessages || [])];
    await this.flush();
    const tg = this.bot?.telegram;
    for (let i = 0; tg && i < ids.length; i += 100) {
      await tg.callApi('deleteMessages', { chat_id: this.allowedUserId, message_ids: ids.slice(i, i + 100) }).catch(() => {});
    }
    this.planMsg = null;
    this.doneMsg = null;
    this.askMsg = null;
    if (this.session) this.session.touch({ telegramMessages: [] });
    return this.#newSession();
  }

  #statusLabel() {
    return STATUS_TEXT[this.sm.status] || this.sm.status;
  }

  #modeLine() {
    return `⚙️ Mod: <b>${esc(MODE_TEXT[this.sm.permissionMode] || this.sm.permissionMode)}</b>`;
  }

  #modeKeyboard() {
    const now = this.sm.permissionMode || 'default';
    return Markup.inlineKeyboard([MODES.map((m) => button(`${m === now ? '✓ ' : ''}${MODE_TEXT[m]}`, `mode:${m}`))]);
  }

  #statusCard() {
    const s = this.sm.snapshot();
    const label = (id) => {
      const a = s.agents[id] || {};
      const model = a.resolvedModel || a.model;
      return `${a.label || id}${model ? ` (${model})` : ''}`;
    };
    const text = statusCard({
      folder: this.#folder(),
      status: s.status,
      session: this.session ? { shortId: this.session.shortId, turns: this.session.turns.length, title: this.session.title } : null,
      mode: s.permissionMode || 'default',
      chief: label(s.chief),
      workers: s.workers.map(label),
    });
    const rows = [[button(`⚙️ ${t('Mode')}: ${MODE_TEXT[s.permissionMode] || MODE_TEXT.default} ▸`, 'st:mode')]];
    if (this.sm.busy) rows.push([button(`⏹ ${t('Stop')}`, 'st:stop')]);
    else rows.push([button(`🆕 ${t('New chat')}`, 'st:new'), button(`🗜 ${t('Summarize')}`, 'st:compact')]);
    if (s.status === 'DONE' && s.snapshotSha) rows.push([button(`↩️ ${t('Undo the last change')}`, 'st:undo')]);
    return { text, keyboard: Markup.inlineKeyboard(rows) };
  }

  #sendStatus() {
    const card = this.#statusCard();
    return this.#send(card.text, card.keyboard);
  }
}
