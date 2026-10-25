import fs from 'node:fs';
import path from 'node:path';

const KEEP = 1000;

/**
 * Prompt history shared by all Kerberos runs (~/.kerberos/history.jsonl), filtered to
 * the current project for ↑/↓ and ctrl+r, like Claude Code's per-project history.
 */
export class PromptHistory {
  constructor(file, root) {
    this.file = file;
    this.root = root;
    this.entries = this.#load();
  }

  #load() {
    try {
      return fs
        .readFileSync(this.file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter((e) => e && e.root === this.root && typeof e.text === 'string')
        .map((e) => e.text)
        .slice(-KEEP);
    } catch {
      return [];
    }
  }

  /** Oldest first. */
  get list() {
    return this.entries;
  }

  add(text) {
    const t = String(text || '').trim();
    if (!t || this.entries[this.entries.length - 1] === t) return;
    this.entries.push(t);
    if (this.entries.length > KEEP) this.entries.shift();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify({ text: t, root: this.root, at: new Date().toISOString() })}\n`);
    } catch {
      // history is a convenience; never break the prompt over it
    }
  }

  /** Newest first, de-duplicated, containing `query` (case-insensitive). */
  search(query = '', limit = 30) {
    const q = query.toLowerCase();
    const out = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.entries[i];
      if (e.toLowerCase().includes(q) && !out.includes(e)) out.push(e);
    }
    return out;
  }
}
