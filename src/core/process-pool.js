import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';

const IS_WIN = process.platform === 'win32';

/** Kill a child and all of its descendants. */
export function killTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    if (IS_WIN) {
      // .cmd shims run behind cmd.exe, so SIGKILL alone would orphan the real CLI.
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      // Children are spawned detached, i.e. as process-group leaders.
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}

/**
 * Concurrency-limited registry of live agent subprocesses.
 * Every spawn goes through `run()` so `killAll()` can reach it.
 */
export class ProcessPool extends EventEmitter {
  constructor({ maxConcurrency = 3 } = {}) {
    super();
    this.maxConcurrency = maxConcurrency;
    this.active = 0;
    this.waiters = [];
    this.children = new Map(); // child -> meta
  }

  async #acquire(signal) {
    if (this.active < this.maxConcurrency) {
      this.active++;
      return;
    }
    await new Promise((resolve, reject) => {
      const waiter = () => {
        signal?.removeEventListener('abort', onAbort);
        this.active++;
        resolve();
      };
      const onAbort = () => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(signal.reason ?? new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  #release() {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }

  /** Run `fn(track)` inside a pool slot; `track(child, meta)` registers the spawned process. */
  async run(fn, { signal } = {}) {
    await this.#acquire(signal);
    const owned = new Set();
    const track = (child, meta = {}) => {
      owned.add(child);
      this.children.set(child, { ...meta, startedAt: Date.now() });
      this.emit('spawn', { pid: child.pid, ...meta });
      child.once?.('exit', () => {
        this.children.delete(child);
        this.emit('exit', { pid: child.pid, ...meta });
      });
    };
    try {
      return await fn(track);
    } finally {
      for (const c of owned) this.children.delete(c);
      this.#release();
    }
  }

  get size() {
    return this.children.size;
  }

  killAll() {
    const n = this.children.size;
    for (const child of this.children.keys()) killTree(child);
    this.children.clear();
    return n;
  }
}
