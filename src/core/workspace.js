import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execa } from 'execa';
import ignore from 'ignore';
import { t } from '../i18n/index.js';

const IS_WIN = process.platform === 'win32';
const SHADOW_EXCLUDE = ['.kerberos/', '.git/', 'node_modules/', '.next/', '.nuxt/', '.svelte-kit/', '.vite/', '.parcel-cache/', '.turbo/', '.cache/'];
const ALWAYS_IGNORED = ['.git', 'node_modules', 'dist', 'build', '.kerberos', '.next', 'coverage', '__pycache__', '.venv'];

export class JailError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JailError';
  }
}

const norm = (p) => (IS_WIN ? p.toLowerCase() : p);

function isInside(root, target) {
  const rel = path.relative(norm(root), norm(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Workspace jail: every write is resolved against `root` and rejected if it escapes,
 * including escapes through symlinked parent directories.
 */
export class Workspace {
  constructor(root = process.cwd(), { denyWrite = [], treeMaxEntries = 400, snippetMaxBytes = 24_000 } = {}) {
    this.root = fs.realpathSync(root);
    this.denyWrite = denyWrite;
    this.treeMaxEntries = treeMaxEntries;
    this.snippetMaxBytes = snippetMaxBytes;
    this.stateDir = path.join(this.root, '.kerberos');
    this.shadowDir = path.join(this.stateDir, 'shadow.git');
    this.changed = new Set();
  }

  /** Resolve a workspace-relative path for writing; throws JailError on escape. */
  resolveSafe(rel) {
    if (typeof rel !== 'string' || rel.trim() === '') throw new JailError(t('Empty file path'));
    if (rel.includes('\0')) throw new JailError(t('Path with an invalid character'));
    if (path.isAbsolute(rel) || path.win32.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
      throw new JailError(`Mutlak yol reddedildi: ${rel}`);
    }
    const abs = path.resolve(this.root, rel);
    if (!isInside(this.root, abs)) throw new JailError(`${t('Write outside the workspace refused')}: ${rel}`);

    const relNorm = path.relative(this.root, abs).split(path.sep);
    for (const denied of this.denyWrite) {
      const parts = denied.split(/[\\/]/);
      if (parts.every((p, i) => relNorm[i] !== undefined && norm(relNorm[i]) === norm(p))) {
        throw new JailError(`${t('Write to a protected path refused')}: ${rel}`);
      }
    }

    // Follow symlinks on the deepest existing ancestor (or the file itself).
    let probe = abs;
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    const real = fs.realpathSync(probe);
    if (!isInside(this.root, real)) throw new JailError(`${t('Escape through a symlink refused')}: ${rel}`);
    return abs;
  }

  toRel(abs) {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  async writeFile(rel, content) {
    const abs = this.resolveSafe(rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.kerberos-${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, content, 'utf8');
    await fsp.rename(tmp, abs);
    this.changed.add(this.toRel(abs));
    return abs;
  }

  /** Read for context. Reads are also confined to the workspace. */
  async readFile(rel) {
    const abs = path.resolve(this.root, rel);
    if (!isInside(this.root, abs)) throw new JailError(`${t('Read outside the workspace refused')}: ${rel}`);
    return fsp.readFile(abs, 'utf8');
  }

  async readSnippets(paths, maxBytes = this.snippetMaxBytes) {
    const out = {};
    let budget = maxBytes;
    for (const rel of paths) {
      if (budget <= 0) break;
      try {
        let text = await this.readFile(rel);
        if (text.length > budget) text = `${text.slice(0, budget)}\n/* ...truncated... */`;
        budget -= text.length;
        out[rel] = text;
      } catch {
        // Missing files are normal for create_file tasks.
      }
    }
    return out;
  }

  exists(rel) {
    try {
      return fs.existsSync(path.resolve(this.root, rel));
    } catch {
      return false;
    }
  }

  async #loadIgnore() {
    const ig = ignore().add(ALWAYS_IGNORED);
    try {
      ig.add(await fsp.readFile(path.join(this.root, '.gitignore'), 'utf8'));
    } catch {
      // no .gitignore
    }
    return ig;
  }

  /** Text tree of the workspace (honours .gitignore), capped at maxEntries. */
  async tree(maxEntries = this.treeMaxEntries) {
    const ig = await this.#loadIgnore();
    const lines = [path.basename(this.root) + '/'];
    let count = 0;
    let truncated = false;

    const walk = async (dir, prefix) => {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries = entries
        .filter((e) => {
          const rel = this.toRel(path.join(dir, e.name)) + (e.isDirectory() ? '/' : '');
          return !ig.ignores(rel);
        })
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (let i = 0; i < entries.length; i++) {
        if (count >= maxEntries) {
          truncated = true;
          return;
        }
        const e = entries[i];
        const last = i === entries.length - 1;
        lines.push(`${prefix}${last ? '└── ' : '├── '}${e.name}${e.isDirectory() ? '/' : ''}`);
        count++;
        if (e.isDirectory()) await walk(path.join(dir, e.name), prefix + (last ? '    ' : '│   '));
      }
    };
    await walk(this.root, '');
    if (truncated) lines.push(`... (truncated after ${maxEntries} entries)`);
    return lines.join('\n');
  }

  /** Flat list of relative file paths (forward slashes, .gitignore honoured), for @-mentions. */
  async listFiles(max = 5000) {
    const ig = await this.#loadIgnore();
    const out = [];
    const walk = async (dir) => {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= max) return;
        const rel = this.toRel(path.join(dir, e.name)).replace(/\\/g, '/');
        if (ig.ignores(rel + (e.isDirectory() ? '/' : ''))) continue;
        if (e.isDirectory()) await walk(path.join(dir, e.name));
        else out.push(rel);
      }
    };
    await walk(this.root);
    return out.sort();
  }

  // ---------- Shadow git snapshots (never touches the user's own repo) ----------

  async #git(args, opts = {}) {
    return execa('git', [`--git-dir=${this.shadowDir}`, `--work-tree=${this.root}`, ...args], {
      cwd: this.root,
      env: { GIT_TERMINAL_PROMPT: '0' },
      ...opts,
    });
  }

  async #ensureShadow() {
    if (fs.existsSync(path.join(this.shadowDir, 'HEAD'))) return this.#writeExclude();
    await fsp.mkdir(this.stateDir, { recursive: true });
    await execa('git', ['init', '--bare', '--quiet', this.shadowDir]);
    await this.#git(['config', 'core.bare', 'false']);
    await this.#git(['config', 'core.autocrlf', 'false']);
    await this.#git(['config', 'core.longpaths', 'true']);
    await this.#git(['config', 'user.name', 'kerberos']);
    await this.#git(['config', 'user.email', 'kerberos@localhost']);
    await this.#git(['config', 'commit.gpgsign', 'false']);
    await this.#writeExclude();
  }

  // Installed packages and build caches (npm install for the site check) never go into
  // snapshots, also in projects without a .gitignore.
  async #writeExclude() {
    await fsp.mkdir(path.join(this.shadowDir, 'info'), { recursive: true });
    await fsp.writeFile(path.join(this.shadowDir, 'info', 'exclude'), `${SHADOW_EXCLUDE.join('\n')}\n`);
  }

  async snapshot(label = 'snapshot') {
    await this.#ensureShadow();
    await this.#git(['add', '-A']);
    await this.#git(['commit', '--allow-empty', '--quiet', '--no-verify', '-m', `kerberos ${label} ${new Date().toISOString()}`]);
    const { stdout } = await this.#git(['rev-parse', 'HEAD']);
    const sha = stdout.trim();
    this.changed.clear();
    return sha;
  }

  async diffSummary(sha) {
    await this.#git(['add', '-A']);
    const [{ stdout: stat }, { stdout: names }, { stdout: nums }] = await Promise.all([
      this.#git(['diff', '--cached', '--stat', '--no-color', sha]),
      this.#git(['diff', '--cached', '--name-status', '--no-color', sha]),
      this.#git(['diff', '--cached', '--numstat', '--no-color', sha]),
    ]);
    const counts = new Map();
    for (const l of nums.split('\n').filter(Boolean)) {
      const [add, del, ...rest] = l.split('\t');
      counts.set(rest[rest.length - 1], { added: Number(add) || 0, removed: Number(del) || 0 });
    }
    const files = names
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [status, ...rest] = l.split('\t');
        const p = rest[rest.length - 1];
        return { status: status[0], path: p, ...(counts.get(p) || { added: 0, removed: 0 }) };
      });
    return { stat: stat.trim(), files };
  }

  /** Unified diff against a snapshot, capped to `maxLines`. */
  async diffText(sha, maxLines = 400) {
    await this.#git(['add', '-A']);
    const { stdout } = await this.#git(['diff', '--cached', '--no-color', sha]);
    const lines = stdout.split('\n');
    return lines.length > maxLines ? [...lines.slice(0, maxLines), `… (${t('{n} more lines', { n: lines.length - maxLines })})`].join('\n') : stdout;
  }

  async rollback(sha) {
    if (!sha) throw new Error(t('No snapshot to undo'));
    await this.#ensureShadow();
    await this.#git(['add', '-A']);
    await this.#git(['reset', '--hard', '--quiet', sha]);
    this.changed.clear();
  }

  // ---------- Scratch files ----------

  async tmpFile(name, content) {
    const dir = path.join(this.stateDir, 'tmp');
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${name}`);
    await fsp.writeFile(file, content, 'utf8');
    return file;
  }
}
