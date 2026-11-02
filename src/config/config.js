import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export const DEFAULT_CONFIG = {
  chief: 'claude',
  fallbackChief: 'codex',
  workers: ['codex', 'opencode', 'agy'],
  debateRounds: 1,
  triage: true, // the chief answers chat itself and questions without a plan
  timeoutMs: 180_000,
  maxConcurrency: 3,
  agentCooldownMs: 120_000,
  permissionMode: 'default', // default (plan needs approval) | auto | plan
  language: 'en', // interface: en | tr | auto (system language)
  replyLanguage: 'auto', // what the agents answer in: auto (system language) | a code or name
  // After coding every agent reviews the others' files; the authors apply the findings.
  review: { enabled: true, rounds: 1 },
  // Web projects: KERBEROS opens the site in headless Chrome/Edge, uses it, takes
  // screenshots, and every agent reviews them. `npm: false` limits this to static sites.
  preview: { enabled: true, rounds: 1, npm: true, pages: 4, browser: null, installTimeoutMs: 300_000, startTimeoutMs: 90_000 },
  agents: {
    claude: {
      enabled: true,
      label: 'Claude',
      bin: 'claude',
      model: null,
      effort: null, // null = the CLI's own setting (see /status)
      thinkingTokens: null,
      models: ['opus', 'sonnet', 'haiku'],
    },
    codex: {
      enabled: true,
      label: 'Codex',
      bin: 'codex',
      model: null,
      effort: null,
      models: [],
    },
    opencode: {
      enabled: true,
      label: 'OpenCode',
      bin: 'opencode',
      model: null,
      variant: null,
      models: [],
    },
    agy: {
      enabled: true,
      label: 'Antigravity',
      bin: 'agy',
      model: null,
      effort: null,
      models: [],
    },
  },
  workspace: {
    denyWrite: ['.git', '.kerberos', 'node_modules', '.env'],
    treeMaxEntries: 400,
    snippetMaxBytes: 24_000,
  },
  telegram: {
    enabled: true,
    autoStart: false, // TUI starts with RC off (toggle with /rc); headless always starts it
  },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep merge; arrays and scalars from `over` replace those in `base`. */
export function deepMerge(base, over) {
  if (!isPlainObject(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function readJsonIfExists(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read the config file (${file}): ${err.message}`);
  }
}

const installDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Per-user state: settings written by the UI, prompt history, caches, Telegram topics. */
export function kerberosHome({ env = process.env, home = os.homedir() } = {}) {
  return env.KERBEROS_HOME || path.join(home, '.kerberos');
}

export const userSettingsFile = (opts) => path.join(kerberosHome(opts), 'settings.json');

/** Persist choices made in the UI (/model, /effort, /chief, mode), like Claude Code's /model. */
export function saveUserSettings(patch, opts) {
  const file = userSettingsFile(opts);
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // first write
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(deepMerge(cur, patch), null, 2));
  return file;
}

/**
 * Precedence (low -> high): defaults < ~/.kerberosrc < ~/.kerberos/settings.json (UI choices)
 * < <cwd>/kerberos.config.json < <cwd>/.kerberosrc < environment variables.
 */
export function loadConfig(cwd = process.cwd(), { env = process.env, home = os.homedir() } = {}) {
  // .env from the workspace wins over one next to the Kerberos install.
  dotenv.config({ path: path.join(cwd, '.env'), quiet: true });
  dotenv.config({ path: path.join(installDir, '.env'), quiet: true });

  const sources = [];
  let config = structuredClone(DEFAULT_CONFIG);
  for (const file of [
    path.join(home, '.kerberosrc'),
    userSettingsFile({ env, home }),
    path.join(cwd, 'kerberos.config.json'),
    path.join(cwd, '.kerberosrc'),
  ]) {
    const data = readJsonIfExists(file);
    if (data) {
      config = deepMerge(config, data);
      sources.push(file);
    }
  }

  if (env.KERBEROS_CHIEF) config.chief = env.KERBEROS_CHIEF;
  if (env.KERBEROS_TIMEOUT_MS) config.timeoutMs = Number(env.KERBEROS_TIMEOUT_MS);
  if (env.KERBEROS_LANG) config.language = env.KERBEROS_LANG;
  if (env.KERBEROS_REPLY_LANG) config.replyLanguage = env.KERBEROS_REPLY_LANG;
  if (env.MAX_THINKING_TOKENS && config.agents.claude) {
    config.agents.claude.thinkingTokens = Number(env.MAX_THINKING_TOKENS);
  }

  config.telegram = {
    ...config.telegram,
    token: env.TELEGRAM_BOT_TOKEN || null,
    allowedUserId: env.TELEGRAM_ALLOWED_USER_ID ? Number(env.TELEGRAM_ALLOWED_USER_ID) : null,
  };
  config.sources = sources;
  validateConfig(config);
  return config;
}

export function validateConfig(config) {
  const ids = Object.keys(config.agents);
  for (const id of [config.chief, config.fallbackChief, ...config.workers]) {
    if (id && !ids.includes(id)) throw new Error(`Config: unknown agent "${id}"`);
  }
  for (const [id, a] of Object.entries(config.agents)) {
    if (a.effort && !EFFORTS.includes(a.effort)) {
      throw new Error(`Config: ${id}.effort is invalid (${a.effort}); use ${EFFORTS.join('|')}`);
    }
  }
  if (!['default', 'auto', 'plan'].includes(config.permissionMode)) throw new Error('Config: permissionMode must be default | auto | plan');
  if (!(config.timeoutMs > 0)) throw new Error('Config: timeoutMs must be positive');
}
