import { rcCommand } from '../remote/telegram.js';
import { PERMISSION_MODES } from '../core/state-machine.js';
import { MODE_INFO } from './theme.js';
import { t } from '../i18n/index.js';

/**
 * Slash commands, named after their Claude Code / Codex CLI counterparts where one
 * exists. `run(ctx, arg)` gets the App context:
 *   { orch, sm, telegram, workspace, config, sessions, catalog, print, flash, openDialog,
 *     clear, quit, submit, label, setChief, setMode, usage, doctor }
 */
export const COMMANDS = [
  {
    name: 'help',
    desc: 'Show commands and shortcuts',
    run: (ctx) => ctx.print({ type: 'help' }),
  },
  {
    name: 'status',
    desc: 'Session, the agents’ actual models, mode, RC',
    run: (ctx) => ctx.print({ type: 'status' }),
  },
  {
    name: 'usage',
    aliases: ['cost'],
    desc: 'Remaining usage limits and tokens spent per agent',
    run: (ctx) => ctx.usage(),
  },
  {
    name: 'agents',
    desc: 'Manage agents: pick the chief, change model and effort',
    run: (ctx) => ctx.openDialog({ kind: 'agents' }),
  },
  {
    name: 'model',
    args: '[agent]',
    desc: 'Choose an agent’s model (saved)',
    run: (ctx, arg) => ctx.openDialog(arg ? { kind: 'model', agent: arg } : { kind: 'pickAgent', next: 'model' }),
  },
  {
    name: 'effort',
    args: '[agent]',
    desc: 'Choose an agent’s reasoning effort (saved)',
    run: (ctx, arg) => ctx.openDialog(arg ? { kind: 'effort', agent: arg } : { kind: 'pickAgent', next: 'effort' }),
  },
  {
    name: 'chief',
    args: '[agent]',
    desc: 'Change the chief (saved)',
    run: (ctx, arg) => (arg ? ctx.setChief(arg) : ctx.openDialog({ kind: 'pickAgent', next: 'chief' })),
  },
  {
    name: 'mode',
    args: '[default|auto|plan]',
    desc: 'Permission mode: ask, auto, plan only (shift+tab)',
    run: (ctx, arg) => {
      if (!arg) return ctx.openDialog({ kind: 'mode' });
      const m = { ask: 'default', onaylı: 'default', otomatik: 'auto', plan: 'plan' }[arg] || arg;
      if (!PERMISSION_MODES.includes(m)) return ctx.flash({ ok: false, reason: `${t('Mode')}: ${PERMISSION_MODES.join(' | ')}` });
      ctx.setMode(m);
    },
  },
  {
    name: 'plan',
    args: '<task>',
    desc: 'Coding task: skip the chief’s triage and plan right away',
    run: (ctx, arg) => (arg ? ctx.submit(arg, { kind: 'task' }) : ctx.flash({ ok: false, reason: t('Usage: /plan <task>') })),
  },
  {
    name: 'ask',
    args: '<question>',
    desc: 'Question: every agent solves it alone, the chief merges one answer',
    run: (ctx, arg) => (arg ? ctx.submit(arg, { kind: 'question' }) : ctx.flash({ ok: false, reason: t('Usage: /ask <question>') })),
  },
  {
    name: 'approve',
    desc: 'Approve the pending plan and code it',
    run: (ctx) => ctx.flash(ctx.orch.approve('tui')),
  },
  {
    name: 'replan',
    args: '[feedback]',
    desc: 'Debate the plan again (with feedback)',
    run: (ctx, arg) => ctx.flash(ctx.orch.replan(arg, 'tui')),
  },
  {
    name: 'cancel',
    desc: 'Cancel the pending plan or questions',
    run: (ctx) => ctx.flash(ctx.orch.cancel('tui')),
  },
  {
    name: 'abort',
    aliases: ['stop'],
    desc: 'Stop the running agents (esc)',
    run: (ctx) => ctx.flash(ctx.orch.abort('tui')),
  },
  {
    name: 'diff',
    desc: 'Show the diff of the last coding run',
    run: async (ctx) => {
      const sha = ctx.sm.snapshotSha;
      if (!sha) return ctx.flash({ ok: false, reason: t('No changes to show') });
      ctx.print({ type: 'diffText', text: await ctx.workspace.diffText(sha) });
    },
  },
  {
    name: 'undo',
    aliases: ['rollback'],
    desc: 'Undo the last coding run (back to the snapshot)',
    run: async (ctx) => ctx.flash(await ctx.orch.rollback('tui')),
  },
  {
    name: 'resume',
    args: '[id]',
    desc: 'Resume an earlier session',
    run: async (ctx, arg) => {
      if (!arg) return ctx.openDialog({ kind: 'resume' });
      const res = await ctx.sessions.resume(arg);
      ctx.flash(res, res.same ? t('You are already in this session') : null);
    },
  },
  {
    name: 'clear',
    aliases: ['new', 'reset'],
    desc: 'New conversation: reset context, clear the screen (/resume reopens the old one)',
    run: async (ctx) => ctx.flash(await ctx.sessions.newSession()),
  },
  {
    name: 'compact',
    args: '[focus]',
    desc: 'Have the chief summarize the conversation; later tasks see the summary',
    run: async (ctx, arg) => {
      ctx.flash({ ok: true }, t('Compacting context…'));
      const res = await ctx.sessions.compact(arg);
      ctx.flash(res, res.ok ? `🗜️ ${t('{turns} turns summarized ({covered} in total)', res)}` : null);
    },
  },
  {
    name: 'rename',
    args: '<name>',
    desc: 'Name the session',
    run: async (ctx, arg) => {
      if (!arg) return ctx.flash({ ok: false, reason: t('Usage: /rename <name>') });
      await ctx.sessions.rename(arg);
      ctx.flash({ ok: true }, t('Session name: {name}', { name: arg }));
    },
  },
  {
    name: 'config',
    desc: 'Saved settings: language, default mode, RC, debate rounds',
    run: (ctx) => ctx.openDialog({ kind: 'config' }),
  },
  {
    name: 'init',
    desc: 'Create kerberos.config.json in this folder',
    run: async (ctx) => {
      if (ctx.workspace.exists('kerberos.config.json')) return ctx.flash({ ok: false, reason: t('kerberos.config.json already exists') });
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
      ctx.print({ type: 'success', text: t('kerberos.config.json created'), detail: t('Chief, workers, mode, model and effort settings for this folder.') });
    },
  },
  {
    name: 'doctor',
    desc: 'Check the CLIs, logins and Telegram',
    run: (ctx) => ctx.doctor(),
  },
  {
    name: 'rc',
    args: '[on|off]',
    desc: 'Turn Telegram remote control on/off (remembered per session)',
    run: async (ctx, arg) => {
      if (ctx.telegram && !ctx.telegram.active && arg !== 'off') ctx.flash({ ok: true }, t('Connecting to Telegram…'));
      const res = await rcCommand(ctx.telegram, arg);
      const where = res.topic ? ` · ${t('Telegram topic: {topic}', res)}` : res.topic === false ? ` · ${t('single chat (topics off, see /doctor)')}` : '';
      ctx.flash(res, res.on ? `📱 ${t('RC on')}${where}` : t('RC off'));
    },
  },
  {
    name: 'exit',
    aliases: ['quit'],
    desc: 'Quit Kerberos',
    run: (ctx) => ctx.quit(),
  },
];

// Descriptions and argument hints are English here and read translated.
for (const c of COMMANDS) {
  for (const key of ['desc', 'args']) {
    const text = c[key];
    if (text) Object.defineProperty(c, key, { get: () => t(text), enumerable: true });
  }
}

/** Permission modes with their (translated) label, hint and colour. */
export const MODE_OPTIONS = PERMISSION_MODES.map((m) => new Proxy({ id: m }, { get: (o, k) => (k === 'id' ? m : MODE_INFO[m][k]) }));

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
