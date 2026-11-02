import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import React from 'react';
import { render } from 'ink';
import { kerberosHome, loadConfig } from './config/config.js';
import { SessionController, SessionStore } from './core/sessions.js';
import { ModelCatalog } from './core/models.js';
import { PromptHistory } from './core/history.js';
import { Workspace } from './core/workspace.js';
import { ProcessPool } from './core/process-pool.js';
import { StateMachine, Status } from './core/state-machine.js';
import { typedAnswer } from './core/protocol.js';
import { formatReport } from './core/preview.js';
import { setLanguage, setReplyLanguage, t } from './i18n/index.js';
import { Orchestrator } from './core/orchestrator.js';
import { createAdapters } from './adapters/index.js';
import { TelegramBridge, rcCommand } from './remote/telegram.js';
import { App } from './ui/App.jsx';

// Injected from package.json by build.mjs.
export const VERSION = typeof __KERBEROS_VERSION__ === 'string' ? __KERBEROS_VERSION__ : '0.0.0-dev';

const help = () => `kerberos [${t('options')}]

${t('Uses the current folder as the workspace and opens the multi-agent TUI.')}

${t('Options')}:
  -c, --continue      ${t('Continue the latest session in this folder')}
  -r, --resume [id]   ${t('Resume a session (without an id a list opens)')}
  --rc                ${t('Start with remote control (Telegram) on; /rc toggles it in the TUI')}
  --headless          ${t('Run without the TUI (RC on; control through Telegram / stdin)')}
  --no-telegram       ${t('Turn the Telegram bridge off completely')}
  --chief <id>        ${t('Chief agent (claude | codex | opencode | agy)')}
  --rounds <n>        ${t('Number of debate rounds')}
  --timeout <s>       ${t('Timeout for a silent process (seconds)')}
  --lang <en|tr|auto> ${t('Interface language (saved with /config)')}
  -v, --version       ${t('Version')}
  -h, --help          ${t('Help')}
`;

function parseArgs(argv) {
  const opts = { headless: false, telegram: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--headless') opts.headless = true;
    else if (a === '-c' || a === '--continue') opts.continue = true;
    else if (a === '-r' || a === '--resume') opts.resume = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true;
    else if (a === '--rc') opts.rc = true;
    else if (a === '--no-telegram') opts.telegram = false;
    else if (a === '--chief') opts.chief = argv[++i];
    else if (a === '--rounds') opts.rounds = Number(argv[++i]);
    else if (a === '--timeout') opts.timeoutMs = Number(argv[++i]) * 1000;
    else if (a === '--lang') opts.lang = argv[++i];
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else throw new Error(`${t('Unknown option')}: ${a}`);
  }
  return opts;
}

/** Resolve a command on PATH (honours PATHEXT on Windows). */
function onPath(bin) {
  if (path.isAbsolute(bin)) return fs.existsSync(bin);
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      if (dir && fs.existsSync(path.join(dir, bin + ext))) return true;
    }
  }
  return false;
}

export async function main(argv = []) {
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  setLanguage(config.language);
  setReplyLanguage(config.replyLanguage);

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`${err.message}\n\n${help()}`);
    process.exit(2);
  }
  if (opts.lang) config.language = opts.lang;
  setLanguage(config.language);
  if (opts.help) return void console.log(help());
  if (opts.version) return void console.log(VERSION);

  if (opts.chief) config.chief = opts.chief;
  if (opts.rounds) config.debateRounds = opts.rounds;
  if (opts.timeoutMs) config.timeoutMs = opts.timeoutMs;

  const workspace = new Workspace(cwd, config.workspace);
  const pool = new ProcessPool({ maxConcurrency: config.maxConcurrency });
  const adapters = createAdapters(config, { workspace, pool });

  const agents = {};
  const missing = [];
  for (const [id, a] of Object.entries(adapters)) {
    const found = onPath(a.bin);
    if (!found) missing.push(id);
    agents[id] = {
      label: a.label,
      model: a.cfg.model,
      effort: a.cfg.effort,
      variant: a.cfg.variant,
      models: a.cfg.models || [],
      status: found ? 'idle' : 'unavailable',
      note: found ? null : t('not on PATH'),
    };
  }

  const usable = (id) => adapters[id] && !missing.includes(id);
  let chief = usable(config.chief) ? config.chief : [config.fallbackChief, ...Object.keys(adapters)].find(usable);
  if (!chief) {
    console.error(t('No agent CLI found (claude, codex, opencode, agy). Check PATH and kerberos.config.json.'));
    process.exit(1);
  }
  const workers = [...config.workers, ...Object.keys(adapters)].filter((id, i, arr) => adapters[id] && id !== chief && arr.indexOf(id) === i);

  const sm = new StateMachine({ chief, workers, agents, permissionMode: config.permissionMode });
  const orch = new Orchestrator({ config, workspace, pool, adapters, sm });
  missing.forEach((id) => orch.unavailable.add(id));

  // Conversations: new by default, --continue / --resume pick an earlier one.
  const store = new SessionStore(workspace.stateDir);
  const migrated = store.migrateLegacy();
  let session = null;
  try {
    if (typeof opts.resume === 'string') session = store.open(opts.resume);
    else if (opts.continue || migrated) session = migrated || store.latest();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (opts.continue && !session) console.error(t('No session to continue in this folder, starting a new one.'));
  const resumed = Boolean(session);
  session ||= store.create();

  const telegram =
    opts.telegram && config.telegram.enabled
      ? new TelegramBridge({
          token: config.telegram.token,
          allowedUserId: config.telegram.allowedUserId,
          sm,
          orch,
          workspace,
          root: workspace.root,
          logger: (text, level) => sm.log(text, level),
        })
      : null;

  const sessions = new SessionController({ store, sm, orch, telegram });
  await sessions.activate(session, { resumed });

  // Real model names and quotas: CLI defaults now, model lists refreshed in the background.
  const home = kerberosHome();
  const catalog = new ModelCatalog({ cacheFile: path.join(home, 'cache', 'models.json'), bins: Object.fromEntries(Object.entries(adapters).map(([id, a]) => [id, a.bin])) });
  await catalog.loadDefaults().catch(() => {});
  if (catalog.stale) catalog.refresh(Object.keys(adapters).filter(usable)).catch(() => {});
  sm.on('agents', (all) => {
    for (const [id, a] of Object.entries(all)) {
      if (a.resolvedModel) catalog.rememberAlias(id, a.model || catalog.defaults[id]?.model, a.resolvedModel);
      if (a.limits && a.limits.at !== catalog.limits(id)?.at) catalog.rememberLimits(id, a.limits);
    }
  });
  const history = new PromptHistory(path.join(home, 'history.jsonl'), workspace.root);

  let cleaning = null;
  const cleanup = () => {
    // Kill agents right away; give Telegram a bounded moment to say goodbye.
    cleaning ??= (async () => {
      orch.shutdown();
      await sessions.close();
      await telegram?.stop({ exiting: true });
    })();
    return cleaning;
  };
  process.on('exit', () => pool.killAll());
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => cleanup().finally(() => process.exit(130)));
  }

  const headless = opts.headless || !process.stdout.isTTY || !process.stdin.isTTY;
  // RC comes back on with the session it was enabled in.
  const autoStartRc = headless || opts.rc || config.telegram.autoStart || (resumed && session.meta.rc);

  if (missing.length && headless) sm.log(`${t('CLIs not found, disabled')}: ${missing.join(', ')}`, 'warn');
  if (telegram?.enabled && autoStartRc) telegram.start().catch((err) => sm.log(`${t('Telegram could not start')}: ${err.message}`, 'error'));

  if (headless) {
    return runHeadless({ sm, orch, workspace, telegram, sessions, cleanup });
  }

  // Inline TUI: finished output goes to the normal scrollback, like Claude Code / Codex.
  // Start on a clean screen: no shell banner ("Microsoft Windows [Version …]") above Kerberos.
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  const app = render(React.createElement(App, { sm, orch, workspace, telegram, config, sessions, catalog, history, version: VERSION, openResume: opts.resume === true, onQuit: cleanup }), {
    exitOnCtrlC: false,
  });
  await app.waitUntilExit();
  await cleanup();
  printResumeHint(sessions.current);
  process.exit(0);
}

/** Codex-style parting line so the conversation can be picked up again. */
function printResumeHint(session) {
  if (!session?.persisted) return;
  const title = session.title ? ` · ${session.title}` : '';
  const [dim, reset] = process.stdout.isTTY ? ['\x1b[90m', '\x1b[0m'] : ['', ''];
  process.stdout.write(`\n${dim}${t('Session')} ${session.shortId}${title}\n${t('To resume')}:${reset} kerberos --resume ${session.shortId}\n`);
}

/** Plain-log mode for daemons / non-TTY use. Lines on stdin act like the TUI prompt. */
function runHeadless({ sm, orch, workspace, telegram, sessions, cleanup }) {
  const ts = () => new Date().toLocaleTimeString();
  const out = (s) => process.stdout.write(`[${ts()}] ${s}\n`);
  out(`KERBEROS headless · ${workspace.root} · ${t('chief')}: ${sm.chief} · ${t('session')} ${sessions.current.shortId}`);
  const askOpen = () => {
    const i = orch.openQuestion;
    if (i < 0) return;
    const q = sm.questions[i];
    const opts = q.options.map((o, k) => `    ${k + 1}. ${o.label}${o.description ? ` · ${o.description}` : ''}`).join('\n');
    out(`${t('QUESTION')} ${i + 1}/${sm.questions.length}: ${q.question}\n${opts}\n  → ${t(q.multiSelect ? 'numbers (1,3) or your own answer, /cancel' : 'a number or your own answer, /cancel')}`);
  };
  sm.on('state', (s, { action, source }) => {
    if (action === 'update') return;
    out(`● ${s.status} [${s.mode}] (${action}, ${source})`);
    if (action === 'planReady') {
      const q = s.plan.questions?.length ? `\n  ${t('questions')}:\n${s.plan.questions.map((x) => `    ? ${x}`).join('\n')}\n  (${t('type an answer and press Enter → replanned')})` : '';
      out(`PLAN: ${s.plan.summary}\n  ${t('files')}: ${s.plan.files_to_modify.join(', ') || `(${t('no changes')})`}${q}\n  → /approve, /replan <${t('note')}>, /cancel`);
    }
    if (action === 'clarify') askOpen();
    if (action === 'answer') out(`${t('ANSWER')}${s.answeredBy > 1 ? ` (${t('{n} agents', { n: s.answeredBy })})` : ''}:\n${s.answer}`);
    if (action === 'buildDone') out(`DIFF:\n${s.diff?.stat || t('no changes')}\n  → ${t('/undo to revert')}`);
  });
  const onLog = ({ level, text }) => out(`${level === 'info' || level === 'debug' ? '·' : level.toUpperCase()} ${text}`);
  sm.logHistory.forEach(onLog);
  sm.on('log', onLog);
  sm.on('note', (n) => {
    if (n.kind === 'phase') out(`◆ ${n.text}${n.detail ? ` · ${n.detail}` : ''}${(n.findings || []).map((f) => `\n  [${f.severity}] ${f.file} · ${f.issue} (${f.by})`).join('')}`);
    else if (n.kind === 'fix') out(`✎ ${n.task.file_path} (${n.task.workerLabel})`);
    else if (n.kind === 'preview') out(formatReport(n.report, { root: n.root }));
  });
  sm.on('chunk', ({ label, role, kind, text }) => {
    if (kind === 'start') out(`▶ ${label} (${role})`);
    else if (kind === 'end') out(`■ ${t('{name} finished', { name: label })}`);
    else if (kind === 'error') out(`✖ ${label}: ${text.trim()}`);
  });

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) return;
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ');
    let res;
    switch (cmd) {
      case '/approve':
        res = orch.approve('tui');
        break;
      case '/replan':
        res = orch.replan(arg, 'tui');
        break;
      case '/cancel':
        res = orch.cancel('tui');
        break;
      case '/abort':
        res = orch.abort('tui');
        break;
      case '/undo':
      case '/rollback':
        res = await orch.rollback('tui');
        break;
      case '/rc':
        res = await rcCommand(telegram, arg);
        break;
      case '/mode':
        res = arg ? orch.setPermissionMode(arg) : orch.cyclePermissionMode();
        if (res.ok) out(`${t('mode')}: ${sm.permissionMode}`);
        break;
      case '/quit':
        await cleanup();
        printResumeHint(sessions.current);
        process.exit(0);
        break;
      default:
        res =
          sm.status === Status.AWAITING_ANSWERS
            ? orch.answerQuestion(orch.openQuestion, typedAnswer(sm.questions[orch.openQuestion], text), 'tui')
            : sm.status === Status.AWAITING_APPROVAL
              ? orch.replan(text, 'tui')
              : orch.submit(text, 'tui');
    }
    if (res && !res.ok) out(`ℹ ${res.reason}`);
    else if (sm.status === Status.AWAITING_ANSWERS) askOpen();
  });
  // Stay alive for Telegram even after stdin closes.
  return new Promise(() => {});
}
