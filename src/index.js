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
import { Orchestrator } from './core/orchestrator.js';
import { createAdapters } from './adapters/index.js';
import { TelegramBridge, rcCommand } from './remote/telegram.js';
import { App } from './ui/App.jsx';

// Injected from package.json by build.mjs.
export const VERSION = typeof __KERBEROS_VERSION__ === 'string' ? __KERBEROS_VERSION__ : '0.0.0-dev';

const HELP = `kerberos [seçenekler]

Bulunduğunuz dizini çalışma alanı kabul eder ve çoklu ajan TUI'sini açar.

Seçenekler:
  -c, --continue      Bu dizindeki en son oturuma devam et
  -r, --resume [id]   Bir oturuma devam et (id verilmezse liste açılır)
  --rc                Uzaktan kontrolü (Telegram) açık başlat. TUI'de /rc ile aç/kapat
  --headless          TUI olmadan çalış (RC açık; Telegram / stdin ile kontrol)
  --no-telegram       Telegram köprüsünü tamamen devre dışı bırak
  --chief <id>        Şef ajanı (claude | codex | opencode | agy)
  --rounds <n>        Tartışma tur sayısı
  --timeout <sn>      Çıktısız süreç zaman aşımı (saniye)
  -v, --version       Sürüm
  -h, --help          Yardım
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
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else throw new Error(`Bilinmeyen seçenek: ${a}`);
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
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`${err.message}\n\n${HELP}`);
    process.exit(2);
  }
  if (opts.help) return void console.log(HELP);
  if (opts.version) return void console.log(VERSION);

  const cwd = process.cwd();
  const config = loadConfig(cwd);
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
      note: found ? null : 'PATH’te yok',
    };
  }

  const usable = (id) => adapters[id] && !missing.includes(id);
  let chief = usable(config.chief) ? config.chief : [config.fallbackChief, ...Object.keys(adapters)].find(usable);
  if (!chief) {
    console.error('Hiçbir ajan CLI’ı bulunamadı (claude, codex, opencode, agy). PATH ve kerberos.config.json’u kontrol edin.');
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
  if (opts.continue && !session) console.error('Bu dizinde sürdürülecek oturum yok, yeni oturum açılıyor.');
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

  if (missing.length && headless) sm.log(`Bulunamayan CLI'lar devre dışı: ${missing.join(', ')}`, 'warn');
  if (telegram?.enabled && autoStartRc) telegram.start().catch((err) => sm.log(`Telegram başlatılamadı: ${err.message}`, 'error'));

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
  process.stdout.write(`\n${dim}Oturum ${session.shortId}${title}\nSürdürmek için:${reset} kerberos --resume ${session.shortId}\n`);
}

/** Plain-log mode for daemons / non-TTY use. Lines on stdin act like the TUI prompt. */
function runHeadless({ sm, orch, workspace, telegram, sessions, cleanup }) {
  const ts = () => new Date().toLocaleTimeString();
  const out = (s) => process.stdout.write(`[${ts()}] ${s}\n`);
  out(`KERBEROS headless · ${workspace.root} · şef: ${sm.chief} · oturum ${sessions.current.shortId}`);
  sm.on('state', (s, { action, source }) => {
    if (action === 'update') return;
    out(`● ${s.status} [${s.mode}] (${action}, ${source})`);
    if (action === 'planReady') {
      const q = s.plan.questions?.length ? `\n  sorular:\n${s.plan.questions.map((x) => `    ? ${x}`).join('\n')}\n  (yanıtı yazıp Enter → yeniden planlanır)` : '';
      out(`PLAN: ${s.plan.summary}\n  dosyalar: ${s.plan.files_to_modify.join(', ') || '(değişiklik yok)'}${q}\n  → /approve, /replan <not>, /cancel`);
    }
    if (action === 'answer') out(`YANIT${s.answeredBy > 1 ? ` (${s.answeredBy} ajan)` : ''}:\n${s.answer}`);
    if (action === 'buildDone') out(`DIFF:\n${s.diff?.stat || 'değişiklik yok'}\n  → geri almak için /undo`);
  });
  const onLog = ({ level, text }) => out(`${level === 'info' || level === 'debug' ? '·' : level.toUpperCase()} ${text}`);
  sm.logHistory.forEach(onLog);
  sm.on('log', onLog);
  sm.on('chunk', ({ label, role, kind, text }) => {
    if (kind === 'start') out(`▶ ${label} (${role})`);
    else if (kind === 'end') out(`■ ${label} bitti`);
    else if (kind === 'error') out(`✖ ${label}: ${text.trim()}`);
  });

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    const t = line.trim();
    if (!t) return;
    const [cmd, ...rest] = t.split(/\s+/);
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
        if (res.ok) out(`mod: ${sm.permissionMode}`);
        break;
      case '/quit':
        await cleanup();
        printResumeHint(sessions.current);
        process.exit(0);
        break;
      default:
        res = sm.status === Status.AWAITING_APPROVAL ? orch.replan(t, 'tui') : orch.submit(t, 'tui');
    }
    if (res && !res.ok) out(`ℹ ${res.reason}`);
  });
  // Stay alive for Telegram even after stdin closes.
  return new Promise(() => {});
}
