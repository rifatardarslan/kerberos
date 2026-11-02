import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { t } from '../i18n/index.js';

const DAY = 24 * 60 * 60 * 1000;
const CLAUDE_ALIASES = ['opus', 'sonnet', 'haiku'];

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/** Top-level `key = "value"` pairs of a TOML file (stops at the first [table]). */
export function parseTomlTop(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const m = line.match(/^\s*([\w.-]+)\s*=\s*"([^"]*)"/) || line.match(/^\s*([\w.-]+)\s*=\s*([^\s#]+)/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** `agy models` output: one "<id>\t<display name>" per line after a header. */
export function parseAgyModels(text) {
  return String(text)
    .split(/\r?\n/)
    .map((l) => l.split('\t'))
    .filter(([id, name]) => id && name && /^[\w.-]+$/.test(id.trim()))
    .map(([id, name]) => ({ id: id.trim(), name: name.trim() }));
}

/** `opencode models` output: one provider/model per line. */
export function parseOpencodeModels(text) {
  return String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[\w.-]+\/[\w.:@-]+$/.test(l))
    .map((id) => ({ id }));
}

/** node:sqlite still prints an ExperimentalWarning on some Node 24 builds; keep the TUI clean. */
async function openSqlite(file) {
  const orig = process.emitWarning;
  process.emitWarning = (w, ...rest) => (String(w?.message || w).includes('SQLite') ? undefined : orig.call(process, w, ...rest));
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return new DatabaseSync(file, { readOnly: true });
  } finally {
    process.emitWarning = orig;
  }
}

/** Model OpenCode used last (= what `opencode run` picks without -m). Best effort. */
async function opencodeLastModel(home) {
  const file = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
  if (!fs.existsSync(file)) return null;
  let db;
  try {
    db = await openSqlite(file);
    const row = db.prepare(`select data from session_message where type = 'assistant' and data like '%"providerID"%' order by time_created desc limit 1`).get();
    const m = row && String(row.data).match(/"model":\{"id":"([^"]+)","providerID":"([^"]+)"/);
    return m ? `${m[2]}/${m[1]}` : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Model of agy's most recent conversation (agy has no settings key for it). Best effort. */
async function agyLastModel(home, known = []) {
  const dir = path.join(home, '.gemini', 'antigravity-cli', 'conversations');
  let files;
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.db'))
      .map((f) => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
  } catch {
    return null;
  }
  for (const { f } of files.slice(0, 3)) {
    let db;
    try {
      db = await openSqlite(f);
      for (const row of db.prepare('select data from executor_metadata limit 5').all()) {
        const s = Buffer.from(row.data).toString('latin1');
        const ids = s.match(/(?:gemini|claude|gpt)[\w.-]+/g) || [];
        const hit = ids.find((id) => !known.length || known.includes(id));
        if (hit) return hit;
      }
    } catch {
      // locked or different schema
    } finally {
      db?.close();
    }
  }
  return null;
}

/**
 * What each CLI does when Kerberos passes no --model / effort, read from the CLI's own
 * settings, so the UI can say "CLI default · gpt-6.1-sol · high" instead of a bare
 * "default".
 */
export async function readCliDefaults({ home = os.homedir(), known = {} } = {}) {
  const out = { claude: {}, codex: {}, opencode: {}, agy: {} };

  const cs = readJson(path.join(home, '.claude', 'settings.json')) || {};
  out.claude = { model: cs.model || null, effortByModel: Object.fromEntries(Object.entries(cs.modelSettings || {}).map(([m, v]) => [m, v?.effortLevel])) };

  try {
    const t = parseTomlTop(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'));
    out.codex = { model: t.model || null, effort: t.model_reasoning_effort || null };
  } catch {
    // no codex config
  }

  const oc = readJson(path.join(home, '.config', 'opencode', 'opencode.json')) || readJson(path.join(home, '.config', 'opencode', 'opencode.jsonc'));
  out.opencode = { model: oc?.model || (await opencodeLastModel(home)), guessed: !oc?.model };

  const agyKnown = (known.agy || []).map((m) => m.id);
  out.agy = { model: await agyLastModel(home, agyKnown), guessed: true };
  return out;
}

// ------------------------------------------------------------ codex app-server

/**
 * Talk JSON-RPC to `codex app-server` (stdio) for things `codex exec` does not print:
 * the model catalog and the ChatGPT plan's rate limits.
 */
export async function codexAppServer(bin, requests, { timeoutMs = 15_000 } = {}) {
  const child = execa(bin, ['app-server'], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', reject: false, windowsHide: true, buffer: false });
  const results = {};
  let buf = '';
  const wanted = new Set(requests.map((_, i) => i + 2));
  const done = new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
          requests.forEach((r, i) => child.stdin.write(`${JSON.stringify({ id: i + 2, method: r.method, params: r.params ?? {} })}\n`));
        } else if (wanted.has(msg.id)) {
          results[requests[msg.id - 2].method] = msg.result ?? { error: msg.error };
          wanted.delete(msg.id);
          if (!wanted.size) {
            clearTimeout(timer);
            resolve();
          }
        }
      }
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'kerberos', version: '1' } } })}\n`);
  await done;
  child.kill();
  return results;
}

/** Codex `account/rateLimits/read` -> the same window shape the Claude adapter reports. */
export function codexLimits(res) {
  const rl = res?.rateLimits;
  if (!rl) return null;
  const win = (w, id) => w && { id, label: w.windowDurationMins === 300 ? '5-hour session' : w.windowDurationMins === 10080 ? 'Weekly' : `${Math.round(w.windowDurationMins / 60)}h`, used: (w.usedPercent ?? 0) / 100, resetsAt: w.resetsAt ?? null };
  return { plan: rl.planType || null, windows: [win(rl.primary, 'primary'), win(rl.secondary, 'secondary')].filter(Boolean), at: Date.now() };
}

// ------------------------------------------------------------ catalog

/**
 * Model lists per CLI, cached for a day in ~/.kerberos/cache/models.json, plus the
 * aliases seen at runtime (opus -> claude-opus-5-5) and the last known plan quotas.
 */
export class ModelCatalog {
  constructor({ cacheFile, bins = {}, home = os.homedir() }) {
    this.cacheFile = cacheFile;
    this.bins = { claude: 'claude', codex: 'codex', opencode: 'opencode', agy: 'agy', ...bins };
    this.home = home;
    this.cache = readJson(cacheFile) || {};
    this.cache.lists ||= {};
    this.cache.aliases ||= {};
    this.cache.limits ||= {};
    this.defaults = {};
    this.refreshing = null;
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache, null, 2));
    } catch {
      // cache is optional
    }
  }

  async loadDefaults() {
    this.defaults = await readCliDefaults({ home: this.home, known: this.cache.lists });
    return this.defaults;
  }

  list(id) {
    if (id === 'claude') {
      const seen = Object.values(this.cache.aliases.claude || {});
      return [...CLAUDE_ALIASES.map((a) => ({ id: a, name: this.cache.aliases.claude?.[a] })), ...seen.filter((m, i) => seen.indexOf(m) === i).map((m) => ({ id: m }))];
    }
    return this.cache.lists[id] || [];
  }

  get stale() {
    return !this.cache.at || Date.now() - this.cache.at > DAY;
  }

  /** Refresh model lists from the CLIs; runs once at a time, never throws. */
  refresh(ids = ['codex', 'opencode', 'agy']) {
    this.refreshing ??= (async () => {
      const run = (bin, args) => execa(bin, args, { reject: false, timeout: 30_000, windowsHide: true }).then((r) => r.stdout || '');
      const jobs = {
        codex: async () => {
          const r = await codexAppServer(this.bins.codex, [{ method: 'model/list' }]);
          return (r['model/list']?.data || []).filter((m) => !m.hidden).map((m) => ({ id: m.id, name: m.displayName, efforts: (m.supportedReasoningEfforts || []).map((e) => e.reasoningEffort) }));
        },
        opencode: async () => parseOpencodeModels(await run(this.bins.opencode, ['models'])),
        agy: async () => parseAgyModels(await run(this.bins.agy, ['models'])),
      };
      await Promise.all(
        ids
          .filter((id) => jobs[id])
          .map(async (id) => {
            try {
              const list = await jobs[id]();
              if (list.length) this.cache.lists[id] = list;
            } catch {
              // CLI missing or offline: keep the old list
            }
          }),
      );
      this.cache.at = Date.now();
      this.#save();
      this.refreshing = null;
    })();
    return this.refreshing;
  }

  /** Remember what an alias resolved to, e.g. claude "opus" -> "claude-opus-5-5". */
  rememberAlias(agent, alias, resolved) {
    if (!alias || !resolved || alias === resolved) return;
    const a = (this.cache.aliases[agent] ||= {});
    if (a[alias] === resolved) return;
    a[alias] = resolved;
    this.#save();
  }

  resolveAlias(agent, alias) {
    return (alias && this.cache.aliases[agent]?.[alias]) || null;
  }

  rememberLimits(agent, limits) {
    if (!limits?.windows?.length) return;
    this.cache.limits[agent] = { ...limits, at: limits.at || Date.now() };
    this.#save();
  }

  limits(agent) {
    return this.cache.limits[agent] || null;
  }

  async fetchCodexLimits() {
    try {
      const r = await codexAppServer(this.bins.codex, [{ method: 'account/rateLimits/read' }]);
      const l = codexLimits(r['account/rateLimits/read']);
      if (l) this.rememberLimits('codex', l);
      return l;
    } catch {
      return null;
    }
  }
}

/**
 * One wording everywhere (banner, footer, /status, /model):
 *   configured alias:  "opus → claude-opus-5-5"
 *   CLI default:       "CLI default · gpt-6.1-sol"
 */
export function describeModel(id, agent = {}, catalog = null) {
  const def = catalog?.defaults?.[id] || {};
  const resolved = agent.resolvedModel || catalog?.resolveAlias(id, agent.model || def.model);
  if (agent.model) return resolved && resolved !== agent.model ? `${agent.model} → ${resolved}` : agent.model;
  const base = def.model ? (resolved && resolved !== def.model ? `${def.model} → ${resolved}` : def.model) : resolved;
  if (!base) return t('CLI default');
  return `${t('CLI default')} · ${base}${def.guessed && !resolved ? ` (${t('last used')})` : ''}`;
}

export function describeEffort(id, agent = {}, catalog = null) {
  if (id === 'opencode') return agent.variant || t('default');
  if (agent.effort) return agent.effort;
  const def = catalog?.defaults?.[id] || {};
  const resolved = agent.resolvedModel || catalog?.resolveAlias(id, def.model);
  const e = def.effort || def.effortByModel?.[resolved];
  return e ? `${t('CLI default')} · ${e}` : t('CLI default');
}
