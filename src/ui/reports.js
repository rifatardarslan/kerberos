import { execa } from 'execa';
import { t } from '../i18n/index.js';
import { localized } from './theme.js';

/** What to run when a CLI reports AUTH, shown next to the error. */
export const LOGIN_HINT = localized({
  claude: 'open `claude` and run /login',
  codex: '`codex login`',
  opencode: '`opencode auth login`',
  agy: 'open `agy` and sign in',
});

export const INSTALL_HINT = {
  claude: 'npm i -g @anthropic-ai/claude-code',
  codex: 'npm i -g @openai/codex',
  opencode: 'npm i -g opencode-ai',
  agy: 'Antigravity CLI install (agy install)',
};

const NO_QUOTA = localized({
  opencode: 'OpenCode does not report remaining limits',
  agy: 'Antigravity does not report remaining limits',
});

export function agentOrder(sm) {
  return [sm.chief, ...sm.workers, ...Object.keys(sm.agents)].filter((id, i, a) => id && a.indexOf(id) === i);
}

/**
 * Rows for /usage. Claude reports its quota on every call (cached), Codex is asked
 * on demand through `codex app-server`; the others expose no quota.
 */
export async function buildUsage({ sm, session, catalog }) {
  const ids = agentOrder(sm).filter((id) => sm.agents[id]?.status !== 'unavailable');
  const codex = ids.includes('codex') ? await catalog.fetchCodexLimits() : null;
  const rows = ids.map((id) => {
    const a = sm.agents[id] || {};
    const limits = id === 'codex' ? codex || catalog.limits('codex') : a.limits || catalog.limits(id);
    const note =
      id === 'claude'
        ? t('Not measured yet: shows up after the first Claude call')
        : id === 'codex'
          ? t('Could not read the Codex limits (codex app-server)')
          : NO_QUOTA[id];
    return { id, label: a.label || id, plan: limits?.plan, windows: limits?.windows, limitsAt: limits?.at, usage: session?.meta.usage?.[id], note };
  });
  const total = rows.reduce((t, r) => ({ tokens: t.tokens + (r.usage?.input || 0) + (r.usage?.output || 0), cost: t.cost + (r.usage?.cost || 0) }), { tokens: 0, cost: 0 });
  return { type: 'usage', rows, total, now: Date.now() };
}

async function version(bin) {
  try {
    const r = await execa(bin, ['--version'], { reject: false, timeout: 15_000, windowsHide: true });
    return r.exitCode === 0 ? (r.stdout || r.stderr).trim().split('\n')[0].slice(0, 80) : null;
  } catch {
    return null;
  }
}

/** /doctor: binaries, versions, git, Telegram (topic mode), settings. */
export async function runDoctor({ sm, orch, telegram, workspace, settingsFile }) {
  const checks = [];
  await Promise.all(
    agentOrder(sm).map(async (id, i) => {
      const a = sm.agents[id] || {};
      const bin = orch.adapters[id]?.bin || id;
      if (a.status === 'unavailable') {
        checks.push({ order: 0, i, ok: false, name: a.label || id, detail: `${t('"{bin}" not found', { bin })}${a.note ? ` (${a.note})` : ''} · ${t('install')}: ${INSTALL_HINT[id] || t('check PATH')}` });
        return;
      }
      const v = await version(bin);
      checks.push({ order: 0, i, ok: v ? true : null, name: a.label || id, detail: v ? `${v} · ${t('login trouble')}: ${LOGIN_HINT[id] || '—'}` : t('"{bin} --version" did not answer', { bin }) });
    }),
  );
  const git = await version('git');
  checks.push({ order: 1, ok: Boolean(git), name: 'git', detail: git || t('git not found: snapshot / undo will not work') });

  if (!telegram) checks.push({ order: 2, ok: null, name: 'Telegram', detail: t('disabled (--no-telegram)') });
  else if (!telegram.enabled) checks.push({ order: 2, ok: null, name: 'Telegram', detail: t('TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_ID are missing from .env') });
  else {
    const me = await telegram.probe();
    if (!me.ok) checks.push({ order: 2, ok: false, name: 'Telegram', detail: `${t('could not connect')}: ${me.reason}` });
    else {
      checks.push({ order: 2, ok: true, name: 'Telegram', detail: `@${me.username} · RC ${telegram.status === 'on' ? `${t('on')} (${telegram.role === 'hub' ? t('polling in this process') : t('through the hub')})` : t('off')}` });
      checks.push({
        order: 3,
        ok: me.topics ? true : null,
        name: t('Topics'),
        detail: me.topics ? t('on: every project folder is its own Telegram topic, 🐺 Kerberos lobby') : t('off: BotFather Mini App (Open) → My bots → your bot → Bot Settings → Threads Settings → Threaded Mode (single chat for now)'),
      });
    }
  }
  checks.push({ order: 4, ok: true, name: t('Settings'), detail: settingsFile });
  checks.push({ order: 5, ok: true, name: t('Workspace'), detail: workspace.root });
  checks.sort((x, y) => x.order - y.order || (x.i ?? 0) - (y.i ?? 0));
  return { type: 'doctor', checks };
}
