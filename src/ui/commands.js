import { rcCommand } from '../remote/telegram.js';
import { PERMISSION_MODES } from '../core/state-machine.js';
import { MODE_INFO } from './theme.js';

/**
 * Slash commands, named after their Claude Code / Codex CLI counterparts where one
 * exists. `run(ctx, arg)` gets the App context:
 *   { orch, sm, telegram, workspace, config, sessions, catalog, print, flash, openDialog,
 *     clear, quit, submit, label, setChief, setMode, usage, doctor }
 */
export const COMMANDS = [
  {
    name: 'help',
    desc: 'Komutları ve kısayolları göster',
    run: (ctx) => ctx.print({ type: 'help' }),
  },
  {
    name: 'status',
    desc: 'Oturum, ajanların gerçek modelleri, mod, RC',
    run: (ctx) => ctx.print({ type: 'status' }),
  },
  {
    name: 'usage',
    aliases: ['cost'],
    desc: 'Ajan başına kalan kullanım limiti ve harcanan token',
    run: (ctx) => ctx.usage(),
  },
  {
    name: 'agents',
    desc: 'Ajanları yönet: şef seç, model ve effort değiştir',
    run: (ctx) => ctx.openDialog({ kind: 'agents' }),
  },
  {
    name: 'model',
    args: '[ajan]',
    desc: 'Bir ajanın modelini seç (kalıcı)',
    run: (ctx, arg) => ctx.openDialog(arg ? { kind: 'model', agent: arg } : { kind: 'pickAgent', next: 'model' }),
  },
  {
    name: 'effort',
    args: '[ajan]',
    desc: 'Bir ajanın reasoning effort düzeyini seç (kalıcı)',
    run: (ctx, arg) => ctx.openDialog(arg ? { kind: 'effort', agent: arg } : { kind: 'pickAgent', next: 'effort' }),
  },
  {
    name: 'chief',
    args: '[ajan]',
    desc: 'Şefi değiştir (kalıcı)',
    run: (ctx, arg) => (arg ? ctx.setChief(arg) : ctx.openDialog({ kind: 'pickAgent', next: 'chief' })),
  },
  {
    name: 'mode',
    args: '[default|auto|plan]',
    desc: 'İzin modu: onaylı, otomatik, yalnızca plan (shift+tab)',
    run: (ctx, arg) => {
      if (!arg) return ctx.openDialog({ kind: 'mode' });
      const m = { onaylı: 'default', otomatik: 'auto', plan: 'plan' }[arg] || arg;
      if (!PERMISSION_MODES.includes(m)) return ctx.flash({ ok: false, reason: `Mod: ${PERMISSION_MODES.join(' | ')}` });
      ctx.setMode(m);
    },
  },
  {
    name: 'plan',
    args: '<görev>',
    desc: 'Kod görevi: şefin değerlendirmesini atla, doğrudan planla',
    run: (ctx, arg) => (arg ? ctx.submit(arg, { kind: 'task' }) : ctx.flash({ ok: false, reason: 'Kullanım: /plan <görev>' })),
  },
  {
    name: 'ask',
    args: '<soru>',
    desc: 'Soru: bütün ajanlar ayrı ayrı çözer, şef tek yanıtta birleştirir',
    run: (ctx, arg) => (arg ? ctx.submit(arg, { kind: 'question' }) : ctx.flash({ ok: false, reason: 'Kullanım: /ask <soru>' })),
  },
  {
    name: 'approve',
    desc: 'Bekleyen planı onayla ve kodla',
    run: (ctx) => ctx.flash(ctx.orch.approve('tui')),
  },
  {
    name: 'replan',
    args: '[geri bildirim]',
    desc: 'Planı (geri bildirimle) yeniden tartıştır',
    run: (ctx, arg) => ctx.flash(ctx.orch.replan(arg, 'tui')),
  },
  {
    name: 'cancel',
    desc: 'Bekleyen planı iptal et',
    run: (ctx) => ctx.flash(ctx.orch.cancel('tui')),
  },
  {
    name: 'abort',
    aliases: ['stop'],
    desc: 'Çalışan ajanları durdur (esc)',
    run: (ctx) => ctx.flash(ctx.orch.abort('tui')),
  },
  {
    name: 'diff',
    desc: 'Son kodlamanın diff’ini göster',
    run: async (ctx) => {
      const sha = ctx.sm.snapshotSha;
      if (!sha) return ctx.flash({ ok: false, reason: 'Gösterilecek değişiklik yok' });
      ctx.print({ type: 'diffText', text: await ctx.workspace.diffText(sha) });
    },
  },
  {
    name: 'undo',
    aliases: ['rollback'],
    desc: 'Son kodlamayı geri al (snapshot’a dön)',
    run: async (ctx) => ctx.flash(await ctx.orch.rollback('tui')),
  },
  {
    name: 'resume',
    args: '[id]',
    desc: 'Önceki bir oturuma devam et',
    run: async (ctx, arg) => {
      if (!arg) return ctx.openDialog({ kind: 'resume' });
      const res = await ctx.sessions.resume(arg);
      ctx.flash(res, res.same ? 'Zaten bu oturumdasınız' : null);
    },
  },
  {
    name: 'clear',
    aliases: ['new', 'reset'],
    desc: 'Yeni sohbet: bağlamı sıfırla, ekranı temizle (önceki /resume ile açılır)',
    run: async (ctx) => ctx.flash(await ctx.sessions.newSession()),
  },
  {
    name: 'compact',
    args: '[odak]',
    desc: 'Sohbet geçmişini şefe özetlet; sonraki görevler özeti görür',
    run: async (ctx, arg) => {
      ctx.flash({ ok: true }, 'Bağlam sıkıştırılıyor…');
      const res = await ctx.sessions.compact(arg);
      ctx.flash(res, res.ok ? `🗜️ ${res.turns} tur özetlendi (toplam ${res.covered})` : null);
    },
  },
  {
    name: 'rename',
    args: '<ad>',
    desc: 'Oturuma ad ver',
    run: async (ctx, arg) => {
      if (!arg) return ctx.flash({ ok: false, reason: 'Kullanım: /rename <ad>' });
      await ctx.sessions.rename(arg);
      ctx.flash({ ok: true }, `Oturum adı: ${arg}`);
    },
  },
  {
    name: 'config',
    desc: 'Kalıcı ayarlar: varsayılan mod, RC, tartışma turu',
    run: (ctx) => ctx.openDialog({ kind: 'config' }),
  },
  {
    name: 'init',
    desc: 'Bu dizine kerberos.config.json oluştur',
    run: async (ctx) => {
      if (ctx.workspace.exists('kerberos.config.json')) return ctx.flash({ ok: false, reason: 'kerberos.config.json zaten var' });
      const agents = {};
      for (const [id, a] of Object.entries(ctx.sm.agents)) {
        agents[id] = { model: a.model ?? null, effort: a.effort ?? null, ...(a.variant ? { variant: a.variant } : {}) };
      }
      const cfg = {
        chief: ctx.sm.chief,
        fallbackChief: ctx.config.fallbackChief,
        workers: ctx.sm.workers,
        debateRounds: ctx.config.debateRounds,
        permissionMode: ctx.sm.permissionMode,
        timeoutMs: ctx.config.timeoutMs,
        agents,
      };
      await ctx.workspace.writeFile('kerberos.config.json', JSON.stringify(cfg, null, 2) + '\n');
      ctx.print({ type: 'success', text: 'kerberos.config.json oluşturuldu', detail: 'Bu dizin için şef, işçiler, mod, model ve effort ayarları.' });
    },
  },
  {
    name: 'doctor',
    desc: 'CLI’ları, girişleri ve Telegram’ı kontrol et',
    run: (ctx) => ctx.doctor(),
  },
  {
    name: 'rc',
    args: '[on|off]',
    desc: 'Telegram uzaktan kontrolü aç/kapat (oturumda hatırlanır)',
    run: async (ctx, arg) => {
      if (ctx.telegram && !ctx.telegram.active && arg !== 'off') ctx.flash({ ok: true }, 'Telegram’a bağlanılıyor…');
      const res = await rcCommand(ctx.telegram, arg);
      const where = res.topic ? ` · Telegram konusu: ${res.topic}` : res.topic === false ? ' · tek sohbet (konular kapalı, bkz. /doctor)' : '';
      ctx.flash(res, res.on ? `📱 RC açık${where}` : 'RC kapatıldı');
    },
  },
  {
    name: 'exit',
    aliases: ['quit'],
    desc: 'Kerberos’tan çık',
    run: (ctx) => ctx.quit(),
  },
];

export const MODE_OPTIONS = PERMISSION_MODES.map((m) => ({ id: m, ...MODE_INFO[m] }));

/** Commands whose name or alias starts with `query` (without the leading slash). */
export function matchCommands(query) {
  const q = query.toLowerCase();
  const exact = [];
  const prefix = [];
  for (const c of COMMANDS) {
    const names = [c.name, ...(c.aliases || [])];
    if (names.includes(q)) exact.push(c);
    else if (names.some((n) => n.startsWith(q))) prefix.push(c);
  }
  return [...exact, ...prefix];
}

export function findCommand(name) {
  const n = name.toLowerCase();
  return COMMANDS.find((c) => c.name === n || c.aliases?.includes(n)) || null;
}
