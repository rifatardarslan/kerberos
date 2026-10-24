import { execa } from 'execa';
import { killTree } from '../core/process-pool.js';

export const ErrorType = {
  RATE_LIMIT: 'RATE_LIMIT',
  AUTH: 'AUTH',
  TIMEOUT: 'TIMEOUT',
  NOT_FOUND: 'NOT_FOUND',
  ABORTED: 'ABORTED',
  CRASH: 'CRASH',
};

export class AgentError extends Error {
  constructor(type, message, { agent, exitCode = null, stderr = '' } = {}) {
    super(message);
    this.name = 'AgentError';
    this.type = type;
    this.agent = agent;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }

  get retryable() {
    return this.type === ErrorType.CRASH;
  }
}

const RATE_LIMIT_RE = /rate.?limit|\b429\b|quota|usage limit|limit reached|too many requests|overloaded|\b529\b|resource.?exhausted|insufficient.?credit/i;
const AUTH_RE = /unauthori[sz]ed|\b401\b|\b403\b|not logged in|please log ?in|authenticat|invalid api key|api key not|login required/i;

/** Classify a failed CLI run. Only call this for runs that actually failed. */
export function classifyError({ exitCode = null, stderr = '', text = '', timedOut = false, aborted = false, notFound = false }) {
  if (aborted) return ErrorType.ABORTED;
  if (timedOut) return ErrorType.TIMEOUT;
  if (notFound) return ErrorType.NOT_FOUND;
  const haystack = `${stderr}\n${text}`;
  if (RATE_LIMIT_RE.test(haystack)) return ErrorType.RATE_LIMIT;
  if (AUTH_RE.test(haystack)) return ErrorType.AUTH;
  return ErrorType.CRASH;
}

const MAX_STDERR = 64 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Base class for CLI agent adapters. Subclasses implement:
 *  - buildArgs({ mode, system })      -> string[]
 *  - buildInput({ prompt, system })   -> string written to stdin
 *  - parseLine(line, state)           -> { chunk?, kind?, final?, error? } | null
 *  - finalize(state)                  -> optional async hook to read the final answer
 */
export class BaseAdapter {
  constructor(id, cfg, { workspace, pool, timeoutMs = 180_000, maxRetries = 1 } = {}) {
    this.id = id;
    this.cfg = cfg;
    this.workspace = workspace;
    this.pool = pool;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
  }

  get label() {
    return this.cfg.label || this.id;
  }

  get bin() {
    return this.cfg.bin || this.id;
  }

  buildArgs() {
    throw new Error('buildArgs not implemented');
  }

  buildInput({ prompt, system }) {
    return system ? `${system}\n\n---\n\n${prompt}` : prompt;
  }

  buildEnv() {
    return {};
  }

  parseLine(line) {
    return { chunk: line + '\n' };
  }

  async prepare() {
    return {};
  }

  async finalize() {}

  /**
   * Run one prompt. Retries once on a generic crash; every other failure type is
   * thrown as an AgentError so the orchestrator can fail over.
   */
  async run({ prompt, system = '', mode = 'PLANNING', onChunk = () => {}, signal } = {}) {
    let attempt = 0;
    for (;;) {
      try {
        return await this.#runOnce({ prompt, system, mode, onChunk, signal });
      } catch (err) {
        const e = err instanceof AgentError ? err : new AgentError(ErrorType.CRASH, err.message, { agent: this.id });
        if (e.retryable && attempt < this.maxRetries && !signal?.aborted) {
          attempt++;
          onChunk({ kind: 'system', text: `[${this.label}] çöktü (${e.message.slice(0, 120)}), yeniden deneniyor...\n` });
          await sleep(1500 * attempt);
          continue;
        }
        throw e;
      }
    }
  }

  async #runOnce({ prompt, system, mode, onChunk, signal }) {
    if (signal?.aborted) throw new AgentError(ErrorType.ABORTED, 'İptal edildi', { agent: this.id });
    const state = { text: '', final: null, error: null, sawDelta: false };
    const prep = await this.prepare({ prompt, system, mode, state });
    const args = this.buildArgs({ prompt, system, mode, state, ...prep });
    const input = this.buildInput({ prompt, system, mode, state, ...prep });

    return this.pool.run(
      (track) =>
        new Promise((resolve, reject) => {
          const started = Date.now();
          let stderr = '';
          let buf = '';
          let timedOut = false;
          let aborted = false;
          let settled = false;
          let idleTimer;

          const child = execa(this.bin, args, {
            cwd: this.workspace.root,
            input,
            env: { NO_COLOR: '1', FORCE_COLOR: '0', ...this.buildEnv({ mode }) },
            buffer: false,
            reject: false,
            stripFinalNewline: false,
            windowsHide: true,
            detached: process.platform !== 'win32',
          });
          track(child, { agent: this.id, mode });

          const kill = () => killTree(child);
          const armIdle = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
              timedOut = true;
              kill();
            }, this.timeoutMs);
          };
          const onAbort = () => {
            aborted = true;
            kill();
          };
          signal?.addEventListener('abort', onAbort, { once: true });
          armIdle();

          const handleLine = (line) => {
            if (!line.trim()) return;
            let ev;
            try {
              ev = this.parseLine(line, state);
            } catch {
              ev = null;
            }
            if (!ev) return;
            if (ev.error) state.error = ev.error;
            if (ev.final != null) state.final = ev.final;
            if (ev.chunk) {
              if (ev.kind !== 'thinking') state.text += ev.chunk;
              onChunk({ kind: ev.kind || 'text', text: ev.chunk });
            }
          };

          child.stdout.setEncoding('utf8');
          child.stdout.on('data', (d) => {
            armIdle();
            buf += d;
            let nl;
            while ((nl = buf.indexOf('\n')) !== -1) {
              handleLine(buf.slice(0, nl).replace(/\r$/, ''));
              buf = buf.slice(nl + 1);
            }
          });
          child.stderr.setEncoding('utf8');
          child.stderr.on('data', (d) => {
            armIdle();
            if (stderr.length < MAX_STDERR) stderr += d;
          });

          const settle = async (exitCode, spawnError) => {
            if (settled) return;
            settled = true;
            clearTimeout(idleTimer);
            signal?.removeEventListener('abort', onAbort);
            if (buf) handleLine(buf);

            // On Windows a missing command surfaces through cmd.exe, not as ENOENT.
            const notFound =
              spawnError?.code === 'ENOENT' ||
              /ENOENT/.test(spawnError?.message || '') ||
              (exitCode !== 0 && !state.text && /is not recognized as an internal or external command|command not found/i.test(stderr));
            const failed = timedOut || aborted || notFound || spawnError || exitCode !== 0 || state.error;
            if (failed) {
              const type = classifyError({
                exitCode,
                stderr,
                text: `${state.error || ''}\n${state.text.slice(-2000)}`,
                timedOut,
                aborted,
                notFound,
              });
              const reason = timedOut
                ? `${Math.round(this.timeoutMs / 1000)} sn boyunca çıktı üretmedi, SIGKILL ile düşürüldü`
                : aborted
                  ? 'İptal edildi'
                  : notFound
                    ? `"${this.bin}" komutu bulunamadı (PATH?)`
                    : state.error || lastLines(stderr) || spawnError?.message || `çıkış kodu ${exitCode}`;
              reject(new AgentError(type, `[${this.label}] ${reason}`, { agent: this.id, exitCode, stderr }));
              return;
            }
            try {
              await this.finalize(state, prep);
            } catch {
              // finalize is best-effort; streamed text is still available
            }
            const text = (state.final || state.text).trim();
            if (!text) {
              reject(new AgentError(ErrorType.CRASH, `[${this.label}] boş yanıt döndü${stderr ? `: ${lastLines(stderr)}` : ''}`, { agent: this.id, exitCode, stderr }));
              return;
            }
            resolve({ agent: this.id, text, durationMs: Date.now() - started });
          };

          child.then(
            (res) => settle(res.exitCode ?? (res.signal ? -1 : 0), res.failed && res.exitCode == null ? res : null),
            (err) => settle(err.exitCode ?? -1, err),
          );
        }),
      { signal },
    );
  }
}

function lastLines(s, n = 4) {
  return s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join(' | ')
    .slice(0, 500);
}

export function safeJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
