import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { compactHistory } from './prompts.js';

const MAX_TURNS = 200;
// Transcript item types worth replaying on resume (help/status/banner are ephemeral).
const PERSIST = new Set(['user', 'agent', 'plan', 'task', 'diff', 'success', 'error', 'phase', 'info']);

export const shortId = (id) => String(id || '').slice(0, 8);

/**
 * Per-project conversations, like `claude --resume` / `codex resume`:
 *   .kerberos/sessions/<uuid>.json   meta: title, settings, RC, Telegram topic, turns
 *   .kerberos/sessions/<uuid>.jsonl  transcript items, append-only, replayed on resume
 * A session is written lazily: nothing hits the disk until it has a turn or a setting.
 */
export class SessionStore {
  constructor(stateDir) {
    this.dir = path.join(stateDir, 'sessions');
    this.legacyFile = path.join(stateDir, 'session.json');
  }

  #metaFile(id) {
    return path.join(this.dir, `${id}.json`);
  }

  #itemsFile(id) {
    return path.join(this.dir, `${id}.jsonl`);
  }

  create(init = {}) {
    const now = new Date().toISOString();
    return new Session(this, {
      id: crypto.randomUUID(),
      title: null,
      createdAt: now,
      updatedAt: now,
      chief: null,
      agentOverrides: {},
      permissionMode: null,
      rc: false,
      telegramThreadId: null,
      turns: [],
      usage: {},
      last: null,
      ...init,
    });
  }

  list() {
    let files = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    return files
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  latest() {
    const meta = this.list()[0];
    return meta ? new Session(this, meta, { persisted: true }) : null;
  }

  /** Open by full id or unique prefix. Throws with a readable message otherwise. */
  open(idOrPrefix) {
    const q = String(idOrPrefix || '').toLowerCase();
    const hits = this.list().filter((m) => m.id === q || m.id.startsWith(q));
    if (!hits.length) throw new Error(`Oturum bulunamadı: ${idOrPrefix}`);
    if (hits.length > 1 && hits[0].id !== q) throw new Error(`Birden fazla oturum eşleşiyor: ${hits.map((m) => shortId(m.id)).join(', ')}`);
    return new Session(this, hits[0], { persisted: true });
  }

  readItems(id) {
    try {
      return fs
        .readFileSync(this.#itemsFile(id), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  async writeMeta(meta) {
    await fsp.mkdir(this.dir, { recursive: true });
    const file = this.#metaFile(meta.id);
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(meta, null, 2));
    await fsp.rename(tmp, file);
  }

  async appendItem(id, item) {
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.appendFile(this.#itemsFile(id), `${JSON.stringify(item)}\n`);
  }

  /**
   * v0.1 kept a single `.kerberos/session.json` with the last build. Turn it into a
   * session once so an unaccepted build from before the upgrade can still be undone.
   */
  migrateLegacy() {
    let old;
    try {
      old = JSON.parse(fs.readFileSync(this.legacyFile, 'utf8'));
    } catch {
      return null;
    }
    try {
      fs.renameSync(this.legacyFile, `${this.legacyFile}.bak`);
    } catch {
      // read-only or already moved: still migrate in memory
    }
    if (old.status !== 'DONE' || !old.snapshot) return null;
    const s = this.create({ title: old.prompt?.slice(0, 60) || null });
    s.meta.turns.push({ id: old.sessionId, request: old.prompt, feedback: [], planSummary: old.plan?.summary, files: old.diff?.files || [], outcome: 'applied', snapshot: old.snapshot, at: s.meta.createdAt });
    s.meta.last = { status: 'DONE', turnId: old.sessionId, prompt: old.prompt, plan: old.plan, diff: old.diff, snapshot: old.snapshot };
    s.save();
    return s;
  }
}

/**
 * Binds one Session at a time to the running state machine / orchestrator / RC bridge,
 * and swaps it for /new and /resume. Emits 'session' (session, { resumed }).
 */
export class SessionController extends EventEmitter {
  constructor({ store, sm, orch, telegram = null }) {
    super();
    this.store = store;
    this.sm = sm;
    this.orch = orch;
    this.telegram = telegram;
    this.current = null;
    this.compacting = false;
    this.untrack = () => {};
    if (telegram) telegram.sessions = this; // /new, /clear, /compact from the phone
    orch.history = (turnId) => this.current?.history(turnId) ?? [];
    orch.summary = () => this.current?.meta.summary?.text ?? null;
    orch.onUsage = (agent, usage) => this.current?.addUsage(agent, usage);
  }

  /** Activate `session`. Refused while agents are running. */
  async activate(session, { resumed = false } = {}) {
    const { sm, orch } = this;
    if (sm.busy) return { ok: false, reason: 'Ajanlar çalışırken oturum değiştirilemez' };
    if (this.current && this.current !== session) {
      this.untrack();
      await this.current.writing;
    }
    this.current = session;

    // Fresh turn state; a finished build from the session stays undoable.
    const last = session.meta.last;
    Object.assign(sm, { status: 'IDLE', mode: 'PLANNING', turnId: null, prompt: null, plan: null, tasks: [], diff: null, snapshotSha: null, error: null, feedback: null });
    if (last?.status === 'DONE' && last.snapshot) {
      Object.assign(sm, { status: 'DONE', mode: 'CODING', turnId: last.turnId, prompt: last.prompt, plan: last.plan, diff: last.diff, snapshotSha: last.snapshot });
    }
    sm.session = { id: session.id, title: session.title };

    if (resumed) {
      if (session.meta.chief && orch.adapters[session.meta.chief]) orch.setChief(session.meta.chief);
      for (const [id, o] of Object.entries(session.meta.agentOverrides || {})) if (orch.adapters[id]) orch.updateAgent(id, o);
      if (session.meta.permissionMode) orch.setPermissionMode(session.meta.permissionMode);
    }
    this.telegram?.bindSession?.(session);
    // RC stays as it is across /new and /resume; remember it for the new session too.
    if (this.telegram?.status === 'on' && !session.meta.rc) session.touch({ rc: true });
    this.untrack = session.track(sm, { telegram: this.telegram });
    const onTitle = (snap, meta) => {
      if (meta.action !== 'update' && sm.session?.title !== session.title) sm.session = { id: session.id, title: session.title };
      if (meta.action === 'update' && snap.permissionMode !== session.meta.permissionMode) session.touch({ permissionMode: snap.permissionMode });
    };
    sm.on('state', onTitle);
    const untrack = this.untrack;
    this.untrack = () => {
      untrack();
      sm.off('state', onTitle);
    };

    sm.update({});
    this.emit('session', session, { resumed });
    return { ok: true, session };
  }

  newSession() {
    return this.activate(this.store.create());
  }

  resume(idOrPrefix) {
    let s;
    try {
      s = this.store.open(idOrPrefix);
    } catch (err) {
      return Promise.resolve({ ok: false, reason: err.message });
    }
    if (s.id === this.current?.id) return Promise.resolve({ ok: true, session: s, same: true });
    return this.activate(s, { resumed: true });
  }

  list() {
    return this.store.list();
  }

  /**
   * /compact: the chief folds the conversation so far into a summary; later prompts
   * carry the summary instead of those turns. `focus` says what must survive.
   */
  async compact(focus = '') {
    const s = this.current;
    if (!s) return { ok: false, reason: 'Oturum yok' };
    if (this.sm.busy || this.compacting) return { ok: false, reason: 'Ajanlar çalışırken bağlam sıkıştırılamaz' };
    const turns = s.history();
    if (!turns.length) return { ok: false, reason: 'Sıkıştırılacak yeni tur yok' };
    this.compacting = this.orch.compacting = true;
    try {
      const prompt = compactHistory({ summary: s.meta.summary?.text, turns, focus: String(focus || '').trim() });
      const text = (await this.orch.callChief(prompt, { step: 'compact' })).trim();
      if (!text) return { ok: false, reason: 'Şef boş özet döndürdü' };
      const covered = (s.meta.summary?.turns || 0) + turns.length;
      await s.save({ summary: { text: text.slice(0, 4000), upToTurnId: turns.at(-1).id, turns: covered, at: new Date().toISOString() } });
      this.emit('compacted', s);
      return { ok: true, turns: turns.length, covered, summary: text };
    } catch (err) {
      return { ok: false, reason: err.message };
    } finally {
      this.compacting = this.orch.compacting = false;
    }
  }

  async rename(title) {
    if (!this.current) return;
    await this.current.rename(title);
    this.sm.session = { id: this.current.id, title: this.current.title };
    this.telegram?.retitle?.();
    this.emit('renamed', this.current);
  }

  async close() {
    if (!this.current) return;
    this.current.closing = true;
    await this.current.writing;
  }
}

export class Session {
  constructor(store, meta, { persisted = false } = {}) {
    this.store = store;
    this.meta = meta;
    this.persisted = persisted;
    this.closing = false;
    this.writing = Promise.resolve();
  }

  get id() {
    return this.meta.id;
  }

  get shortId() {
    return shortId(this.meta.id);
  }

  get title() {
    return this.meta.title;
  }

  get turns() {
    return this.meta.turns;
  }

  items() {
    return this.persisted ? this.store.readItems(this.id) : [];
  }

  /** Serialised so concurrent patches never interleave on disk. */
  save(patch = {}) {
    Object.assign(this.meta, patch, { updatedAt: new Date().toISOString() });
    this.persisted = true;
    const meta = structuredClone(this.meta);
    this.writing = this.writing.then(() => this.store.writeMeta(meta)).catch(() => {});
    return this.writing;
  }

  /** Save only if the session already exists on disk (settings alone do not create one). */
  touch(patch) {
    Object.assign(this.meta, patch);
    return this.persisted ? this.save() : Promise.resolve();
  }

  appendItem(item) {
    if (!PERSIST.has(item.type)) return Promise.resolve();
    const { id, ...rest } = item;
    const doWrite = () => this.store.appendItem(this.id, rest);
    this.writing = this.writing.then(doWrite).catch(() => {});
    if (!this.persisted) this.save();
    return this.writing;
  }

  rename(title) {
    return this.save({ title: String(title).trim().slice(0, 80) || null });
  }

  /** Finished turns since the last /compact, other than the one in flight, oldest first. */
  history(excludeTurnId) {
    const upTo = this.meta.summary?.upToTurnId;
    const from = upTo ? this.meta.turns.findIndex((t) => t.id === upTo) + 1 : 0;
    return this.meta.turns.slice(from).filter((t) => t.id !== excludeTurnId && t.outcome);
  }

  // -------------------------------------------------------------- recording

  /**
   * Record turns, the last build and settings from state-machine events. Kept here
   * (not in the orchestrator) so headless, TUI and Telegram sessions behave the same.
   */
  track(sm, { telegram } = {}) {
    const turn = () => this.meta.turns.find((t) => t.id === sm.turnId);
    const end = (outcome, extra = {}) => {
      const t = turn();
      if (t && !t.outcome) Object.assign(t, { outcome, ...extra });
    };

    const onState = (snap, meta) => {
      if (meta.action === 'update') {
        if (snap.snapshotSha && turn() && turn().snapshot !== snap.snapshotSha) {
          turn().snapshot = snap.snapshotSha;
          this.save();
        }
        if (snap.chief !== this.meta.chief && this.persisted) this.save({ chief: snap.chief });
        return;
      }
      switch (meta.action) {
        case 'submit':
          this.meta.turns.push({ id: snap.turnId, request: snap.prompt, kind: null, feedback: [], planSummary: null, files: [], outcome: null, snapshot: null, at: new Date().toISOString() });
          if (this.meta.turns.length > MAX_TURNS) this.meta.turns.splice(0, this.meta.turns.length - MAX_TURNS);
          break;
        case 'answer':
          end('answered', { answer: String(snap.answer || '').slice(0, 2000) });
          break;
        case 'replan':
          if (snap.feedback && turn()) turn().feedback.push(snap.feedback);
          break;
        case 'planReady':
          if (turn()) turn().planSummary = snap.plan?.summary || null;
          break;
        case 'buildDone':
          end(snap.error ? 'partial' : 'applied', { files: (snap.diff?.files || []).map((f) => ({ path: f.path, status: f.status })) });
          break;
        case 'noop':
          end('noop');
          break;
        case 'cancel':
          end('cancelled');
          break;
        case 'abort':
          end('aborted');
          break;
        case 'fail':
          end('failed', { error: snap.error });
          break;
        case 'rollback': {
          const t = [...this.meta.turns].reverse().find((x) => x.snapshot);
          if (t) t.outcome = 'rolledBack';
          break;
        }
        default:
      }
      const done = snap.status === 'DONE' && snap.snapshotSha;
      this.save({
        chief: snap.chief,
        last: done ? { status: 'DONE', turnId: snap.turnId, prompt: snap.prompt, plan: snap.plan, diff: snap.diff, snapshot: snap.snapshotSha } : null,
      });
    };

    const onAgents = (agents) => {
      const overrides = {};
      for (const [id, a] of Object.entries(agents)) {
        const o = {};
        for (const k of ['model', 'effort', 'variant']) if (a[k] !== undefined) o[k] = a[k];
        overrides[id] = o;
      }
      if (JSON.stringify(overrides) !== JSON.stringify(this.meta.agentOverrides)) this.touch({ agentOverrides: overrides });
    };

    // The chief's triage: small talk does not name the session (or its Telegram topic).
    const onTriage = ({ kind, turnId }) => {
      const t = this.meta.turns.find((x) => x.id === turnId);
      if (t) t.kind = kind;
      if (kind !== 'chat' && !this.meta.title && t) this.meta.title = t.request.replace(/\s+/g, ' ').slice(0, 60);
      this.save();
    };

    const onRc = (status) => {
      if (this.closing || status === 'connecting' || status === 'error') return;
      const rc = status === 'on';
      if (rc !== this.meta.rc) (rc ? this.save({ rc }) : this.touch({ rc }));
    };

    sm.on('state', onState);
    sm.on('agents', onAgents);
    sm.on('triage', onTriage);
    telegram?.on('status', onRc);
    return () => {
      sm.off('state', onState);
      sm.off('agents', onAgents);
      sm.off('triage', onTriage);
      telegram?.off('status', onRc);
    };
  }

  addUsage(agent, usage) {
    if (!usage) return;
    const u = (this.meta.usage[agent] ||= { input: 0, output: 0, cost: 0, calls: 0 });
    u.input += usage.input || 0;
    u.output += usage.output || 0;
    u.cost += usage.cost || 0;
    u.calls += 1;
  }
}
