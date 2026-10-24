import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import React from 'react';
import { render } from 'ink';
import { loadConfig } from './config/config.js';
import { Workspace } from './core/workspace.js';
import { ProcessPool } from './core/process-pool.js';
import { StateMachine, Status } from './core/state-machine.js';
import { Orchestrator } from './core/orchestrator.js';
import { createAdapters } from './adapters/index.js';
import { TelegramBridge } from './remote/telegram.js';
import { App } from './ui/App.jsx';

const VERSION = '0.1.0';

const HELP = `kerberos [seçenekler]

Bulunduğunuz dizini çalışma alanı kabul eder ve çoklu ajan TUI'sini açar.

Seçenekler:
  --headless          TUI olmadan çalış (Telegram / stdin ile kontrol)
  --no-telegram       Telegram köprüsünü başlatma
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

  const sm = new StateMachine({ chief, workers, agents });
  const orch = new Orchestrator({ config, workspace, pool, adapters, sm });
  missing.forEach((id) => orch.unavailable.add(id));

  // Restore a finished build from a previous run so it can still be rolled back.
  const saved = workspace.loadSession();
  if (saved.status === Status.DONE && saved.snapshot) {
    Object.assign(sm, {
      status: Status.DONE,
      mode: 'CODING',
      sessionId: saved.sessionId,
      prompt: saved.prompt,
      plan: saved.plan,
      diff: saved.diff,
      snapshotSha: saved.snapshot,
    });
  }

  const telegram =
    opts.telegram && config.telegram.enabled
      ? new TelegramBridge({
          token: config.telegram.token,
          allowedUserId: config.telegram.allowedUserId,
          sm,
          orch,
          logger: (text, level) => sm.log(text, level),
        })
      : null;

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    orch.shutdown();
    telegram?.stop();
  };
  process.on('exit', () => pool.killAll());
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      cleanup();
      process.exit(130);
    });
  }

  if (missing.length) sm.log(`Bulunamayan CLI'lar devre dışı: ${missing.join(', ')}`, 'warn');
  if (telegram && !telegram.enabled) sm.log('Telegram kapalı (.env içinde TELEGRAM_BOT_TOKEN ve TELEGRAM_ALLOWED_USER_ID tanımlayın)', 'info');
  telegram?.start().catch((err) => sm.log(`Telegram başlatılamadı: ${err.message}`, 'error'));

  if (opts.headless || !process.stdout.isTTY || !process.stdin.isTTY) {
    return runHeadless({ sm, orch, workspace, cleanup });
  }

  // Full-screen TUI on the alternate screen buffer.
  process.stdout.write('\x1b[?1049h\x1b[H');
  const restore = () => process.stdout.write('\x1b[?1049l');
  process.on('exit', restore);
  const app = render(React.createElement(App, { sm, orch, workspace, telegram, onQuit: cleanup }), { exitOnCtrlC: false });
  await app.waitUntilExit();
  cleanup();
  restore();
  process.exit(0);
}

/** Plain-log mode for daemons / non-TTY use. Lines on stdin act like the TUI prompt. */
function runHeadless({ sm, orch, workspace, cleanup }) {
  const ts = () => new Date().toLocaleTimeString();
  const out = (s) => process.stdout.write(`[${ts()}] ${s}\n`);
  out(`KERBEROS headless · ${workspace.root} · şef: ${sm.chief}`);
  sm.on('state', (s, { action, source }) => {
    if (action === 'update') return;
    out(`● ${s.status} [${s.mode}] (${action}, ${source})`);
    if (action === 'planReady') {
      const q = s.plan.questions?.length ? `\n  sorular:\n${s.plan.questions.map((x) => `    ? ${x}`).join('\n')}\n  (yanıtı yazıp Enter → yeniden planlanır)` : '';
      out(`PLAN: ${s.plan.summary}\n  dosyalar: ${s.plan.files_to_modify.join(', ') || '(değişiklik yok)'}${q}\n  → /approve, /replan <not>, /cancel`);
    }
    if (action === 'buildDone') out(`DIFF:\n${s.diff?.stat || 'değişiklik yok'}\n  → /rollback ya da /accept`);
  });
  const onLog = ({ level, text }) => out(`${level === 'info' ? '·' : level.toUpperCase()} ${text}`);
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
      case '/rollback':
        res = await orch.rollback('tui');
        break;
      case '/accept':
        res = orch.accept('tui');
        break;
      case '/quit':
        cleanup();
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
