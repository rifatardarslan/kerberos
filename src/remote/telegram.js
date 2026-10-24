import { EventEmitter } from 'node:events';
import { Telegraf, Markup } from 'telegraf';
import { message } from 'telegraf/filters';

const MAX_LEN = 3900;
const SOURCE_LABEL = { tui: "TUI'den", telegram: "Telegram'dan", system: 'sistem' };

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, n = MAX_LEN) => (s.length > n ? s.slice(0, n - 20) + '\n…(kırpıldı)' : s);
const list = (items) => (items?.length ? items.map((i) => `• ${esc(i)}`).join('\n') : '—');

/** `/rc`, `/rc on`, `/rc off` shared by the TUI and the headless prompt. */
export async function rcCommand(telegram, arg = '') {
  if (!telegram) return { ok: false, reason: 'Telegram devre dışı (--no-telegram)' };
  const a = arg.trim().toLowerCase();
  const want = a === 'on' || a === 'aç' ? true : a === 'off' || a === 'kapat' ? false : !telegram.active;
  const res = await (want ? telegram.start() : telegram.stop());
  return { ...res, on: want };
}

export function formatPlan(plan, prompt) {
  return clip(
    [
      '📋 <b>Konsensüs Planı Hazır</b>',
      prompt ? `<i>${esc(prompt.slice(0, 300))}</i>` : null,
      '',
      esc(plan.summary),
      plan.questions?.length ? `\n❓ <b>Sorular</b> (yanıtı mesaj olarak yazın, plan yeniden hazırlanır)\n${list(plan.questions)}` : null,
      '',
      `<b>Dosyalar</b>\n${list(plan.files_to_modify)}`,
      `<b>Bağımlılıklar</b>\n${list(plan.dependencies)}`,
      `<b>Riskler</b>\n${list(plan.risks)}`,
    ]
      .filter((l) => l !== null)
      .join('\n'),
  );
}

export function formatDiff(diff, tasks = [], error) {
  const icon = { A: '🟢', M: '🟡', D: '🔴', R: '🔵' };
  const files = diff?.files?.length ? diff.files.map((f) => `${icon[f.status] || '⚪'} <code>${esc(f.path)}</code>`).join('\n') : 'Değişiklik yok';
  const failed = tasks.filter((t) => t.status === 'failed');
  return clip(
    [
      error ? '⚠️ <b>Kodlama kısmen tamamlandı</b>' : '✅ <b>Kodlama tamamlandı</b>',
      '',
      files,
      diff?.stat ? `\n<code>${esc(diff.stat.split('\n').pop().trim())}</code>` : '',
      failed.length ? `\n❌ Başarısız: ${failed.map((t) => esc(t.file_path)).join(', ')}` : '',
    ].join('\n'),
  );
}

/**
 * Telegram remote control. Only TELEGRAM_ALLOWED_USER_ID is served; everyone else is
 * silently ignored. Only milestones are pushed (debate started, plan ready, build done,
 * failover, errors); the live debate stays in the TUI.
 */
export class TelegramBridge extends EventEmitter {
  constructor({ token, allowedUserId, sm, orch, root = '', logger = () => {} }) {
    super();
    this.root = root;
    this.token = token;
    this.allowedUserId = allowedUserId;
    this.sm = sm;
    this.orch = orch;
    this.log = logger;
    this.status = 'off';
    this.bot = null;
    this.planMsg = null; // { id, text, sessionId }
    this.doneMsg = null;
    this.queue = Promise.resolve();
    this.onState = this.onState.bind(this);
    this.onFailover = this.onFailover.bind(this);
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

  /** Enable remote control: connect, start polling and announce on the phone. */
  async start() {
    if (!this.enabled) return { ok: false, reason: 'Telegram yapılandırılmamış (.env: TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_ID)' };
    if (this.active) return { ok: true };
    this.#setStatus('connecting');
    const bot = this.createBot();

    try {
      const me = await bot.telegram.getMe();
      this.username = me.username;
    } catch (err) {
      this.#setStatus('error');
      this.log(`Telegram bağlantısı kurulamadı: ${err.message}`, 'error');
      return { ok: false, reason: err.message };
    }
    if (this.bot !== bot) return { ok: false, reason: 'İptal edildi' }; // stopped while connecting

    this.attach();
    bot
      .launch({ dropPendingUpdates: true }, () => {
        this.#setStatus('on');
        this.log(`RC açık: Telegram köprüsü aktif (@${this.username})`);
        this.#send(`🟢 <b>Uzaktan kontrol açık</b>\n📁 <code>${esc(this.root)}</code>\nDurum: ${this.sm.status}`);
      })
      .catch((err) => {
        if (this.bot !== bot) return;
        this.#setStatus('error');
        this.log(`Telegram polling durdu: ${err.message}`, 'error');
      });
    return { ok: true };
  }

  /** Disable remote control. Sends a goodbye first (bounded wait) unless `notify` is false. */
  async stop({ notify = true, reason = 'kapatıldı' } = {}) {
    const bot = this.bot;
    const wasOn = this.status === 'on';
    this.detach();
    this.bot = null;
    this.planMsg = null;
    this.doneMsg = null;
    this.#setStatus('off');
    if (!bot) return { ok: true };
    if (notify && wasOn) {
      const bye = bot.telegram.sendMessage(this.allowedUserId, `🔴 <b>Uzaktan kontrol ${esc(reason)}</b>`, { parse_mode: 'HTML' }).catch(() => {});
      await Promise.race([bye, new Promise((r) => setTimeout(r, 1500))]);
    }
    try {
      bot.stop('rc-off');
    } catch {
      // not running yet
    }
    this.log(`RC ${reason}`);
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
  }

  detach() {
    this.sm.off('state', this.onState);
    this.sm.off('failover', this.onFailover);
  }

  /** Build the Telegraf instance with whitelist, commands and button handlers. */
  createBot() {
    const bot = (this.bot = new Telegraf(this.token, { handlerTimeout: 60_000 }));

    // Whitelist: drop everything not from the allowed user, without replying.
    bot.use((ctx, next) => (ctx.from?.id === this.allowedUserId ? next() : undefined));

    bot.start((ctx) => ctx.reply(this.#statusText(), { parse_mode: 'HTML' }));
    bot.command('status', (ctx) => ctx.reply(this.#statusText(), { parse_mode: 'HTML' }));
    bot.command('help', (ctx) => ctx.reply(this.#helpText(), { parse_mode: 'HTML' }));
    bot.command('abort', (ctx) => {
      const res = this.orch.abort('telegram');
      return ctx.reply(res.ok ? `🛑 Acil durdurma: ${res.killed} süreç sonlandırıldı.` : `ℹ️ ${res.reason}`);
    });
    bot.command('plan', (ctx) => this.#submit(ctx, ctx.payload));
    bot.command('approve', (ctx) => this.#reply(ctx, this.orch.approve('telegram')));
    bot.command('cancel', (ctx) => this.#reply(ctx, this.orch.cancel('telegram')));
    bot.command('rollback', async (ctx) => this.#reply(ctx, await this.orch.rollback('telegram')));

    bot.on(message('text'), (ctx) => {
      const text = ctx.message.text.trim();
      if (text.startsWith('/')) return ctx.reply('Bilinmeyen komut. /help');
      if (this.sm.status === 'AWAITING_APPROVAL') {
        const res = this.orch.replan(text, 'telegram');
        return res.ok ? undefined : ctx.reply(`ℹ️ ${res.reason}`);
      }
      return this.#submit(ctx, text);
    });

    bot.action(/^(approve|replan|cancel|rollback|accept):(\w+)$/, async (ctx) => {
      const [, action, sid] = ctx.match;
      if (sid !== this.sm.sessionId) {
        await ctx.answerCbQuery('Bu buton eski bir oturuma ait.').catch(() => {});
        await ctx.editMessageReplyMarkup(undefined).catch(() => {});
        return;
      }
      let res;
      if (action === 'approve') res = this.orch.approve('telegram');
      else if (action === 'replan') res = this.orch.replan('', 'telegram');
      else if (action === 'cancel') res = this.orch.cancel('telegram');
      else if (action === 'accept') res = this.orch.accept('telegram');
      else res = await this.orch.rollback('telegram');
      await ctx.answerCbQuery(res.ok ? '✓' : res.reason.slice(0, 190)).catch(() => {});
    });

    bot.catch((err) => this.log(`Telegram hatası: ${err.message}`, 'error'));
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
      .catch((err) => this.log(`Telegram gönderim hatası: ${err.message}`, 'warn'));
    return this.queue;
  }

  #send(text, extra = {}) {
    return this.#enqueue((tg) => tg.sendMessage(this.allowedUserId, text, { parse_mode: 'HTML', ...extra }));
  }

  /**
   * Replace a remembered message's keyboard with a status footer (keeps the text).
   * The reference is read inside the queue, so a message that is still being sent
   * is edited correctly once it exists. Returns false via the queue if none.
   */
  #close(key, footer, fallback) {
    return this.#enqueue(async (tg) => {
      const ref = this[key];
      this[key] = null;
      if (!ref) return fallback ? tg.sendMessage(this.allowedUserId, fallback, { parse_mode: 'HTML' }) : null;
      const text = clip(`${ref.text}\n\n${footer}`);
      return tg.editMessageText(this.allowedUserId, ref.id, undefined, text, { parse_mode: 'HTML' });
    });
  }

  /** Send and remember the message under `key` (set before any later queued step runs). */
  #sendKept(key, text, extra) {
    return this.#enqueue(async (tg) => {
      const msg = await tg.sendMessage(this.allowedUserId, text, { parse_mode: 'HTML', ...extra });
      this[key] = { id: msg.message_id, text };
      return msg;
    });
  }

  onState(snap, { action, source }) {
    const by = SOURCE_LABEL[source] || source;
    const sid = snap.sessionId;
    switch (action) {
      case 'submit':
        this.#enqueue(() => {
          this.planMsg = null;
          this.doneMsg = null;
        });
        this.#send(
          `🧠 <b>Tartışma başladı</b>${source === 'tui' ? ' (TUI)' : ''}\n📁 <code>${esc(this.root)}</code>\n<i>${esc(snap.prompt?.slice(0, 500))}</i>`,
        );
        break;
      case 'replan':
        this.#close('planMsg', `🔄 Yeniden planlanıyor (${by})`);
        break;
      case 'planReady': {
        const text = formatPlan(snap.plan, snap.prompt);
        const empty = !snap.plan.files_to_modify?.length;
        const kb = Markup.inlineKeyboard([
          [Markup.button.callback(empty ? '✅ Tamam (değişiklik yok)' : '🚀 Kodu Yazdır', `approve:${sid}`)],
          [Markup.button.callback('🔄 Yeniden Planla', `replan:${sid}`), Markup.button.callback('🛑 İptal', `cancel:${sid}`)],
        ]);
        this.#sendKept('planMsg', text, kb);
        break;
      }
      case 'approve':
        this.#close('planMsg', `✅ Onaylandı (${by}). Kodlanıyor…`);
        break;
      case 'noop':
        this.#close('planMsg', `ℹ️ Uygulanacak değişiklik yok, tur kapatıldı (${by})`);
        break;
      case 'cancel':
        this.#close('planMsg', `🛑 İptal edildi (${by})`);
        break;
      case 'buildDone': {
        const text = formatDiff(snap.diff, snap.tasks, snap.error);
        const kb = Markup.inlineKeyboard([
          [Markup.button.callback('↩️ Geri Al (Rollback)', `rollback:${sid}`), Markup.button.callback('👍 Kabul Et', `accept:${sid}`)],
        ]);
        this.#sendKept('doneMsg', text, kb);
        break;
      }
      case 'rollback':
        this.#close('doneMsg', `↩️ Geri alındı (${by})`, `↩️ Değişiklikler geri alındı (${by})`);
        break;
      case 'reset':
        this.#close('doneMsg', `👍 Kabul edildi (${by})`);
        break;
      case 'abort': {
        this.#close('planMsg', `🛑 Durduruldu (${by})`);
        const kb = snap.snapshotSha ? Markup.inlineKeyboard([[Markup.button.callback('↩️ Geri Al (Rollback)', `rollback:${sid}`)]]) : undefined;
        this.#sendKept('doneMsg', `🛑 <b>Süreç durduruldu</b> (${by})`, kb);
        break;
      }
      case 'fail': {
        const kb = snap.snapshotSha ? Markup.inlineKeyboard([[Markup.button.callback('↩️ Geri Al (Rollback)', `rollback:${sid}`)]]) : undefined;
        this.#sendKept('doneMsg', `⚠️ <b>Hata</b>\n<code>${esc(snap.error?.slice(0, 1500))}</code>`, kb);
        break;
      }
      default:
    }
  }

  onFailover({ from, to, reason }) {
    const label = (id) => esc(this.sm.agents[id]?.label || id);
    this.#send(`🔁 Şeflik devredildi: <b>${label(from)}</b> → <b>${label(to)}</b> (${esc(reason)})`);
  }

  // ------------------------------------------------------------------ inbound helpers

  #submit(ctx, text) {
    if (!text?.trim()) return ctx.reply('Kullanım: /plan <ne yapılsın>  (ya da doğrudan mesaj yazın)');
    const res = this.orch.submit(text, 'telegram');
    if (!res.ok) return ctx.reply(`ℹ️ ${res.reason}`);
  }

  #reply(ctx, res) {
    return ctx.reply(res.ok ? '✓' : `ℹ️ ${res.reason}`);
  }

  #statusText() {
    const s = this.sm.snapshot();
    const label = (id) => esc(s.agents[id]?.label || id);
    return [
      '🐺 <b>KERBEROS</b>',
      `📁 <code>${esc(this.root)}</code>`,
      `Durum: <b>${s.status}</b> [${s.mode}]`,
      `Şef: ${label(s.chief)}`,
      `İşçiler: ${s.workers.map(label).join(', ') || '—'}`,
      s.prompt ? `Görev: <i>${esc(s.prompt.slice(0, 200))}</i>` : null,
      '',
      'Mesaj yazarak görev başlatın. /help',
    ]
      .filter((l) => l !== null)
      .join('\n');
  }

  #helpText() {
    return [
      '<b>Komutlar</b>',
      '/status: durum',
      '/plan &lt;metin&gt;: yeni görev (ya da düz mesaj)',
      '/approve: planı onayla',
      '/cancel: iptal',
      '/rollback: son kodlamayı geri al',
      '/abort: acil durdurma',
      '',
      'Plan onay beklerken yazılan mesaj, yeniden planlama geri bildirimi olarak kullanılır.',
    ].join('\n');
  }
}
