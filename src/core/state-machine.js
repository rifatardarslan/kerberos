import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

export const Status = {
  IDLE: 'IDLE',
  DEBATING: 'DEBATING',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  BUILDING: 'BUILDING',
  DONE: 'DONE',
  ABORTED: 'ABORTED',
  ERROR: 'ERROR',
};

const S = Status;

/** action -> { from: allowed source states, to: target state } */
export const TRANSITIONS = {
  submit: { from: [S.IDLE, S.DONE, S.ABORTED, S.ERROR], to: S.DEBATING },
  planReady: { from: [S.DEBATING], to: S.AWAITING_APPROVAL },
  replan: { from: [S.AWAITING_APPROVAL], to: S.DEBATING },
  approve: { from: [S.AWAITING_APPROVAL], to: S.BUILDING },
  buildDone: { from: [S.BUILDING], to: S.DONE },
  cancel: { from: [S.AWAITING_APPROVAL], to: S.IDLE },
  abort: { from: [S.DEBATING, S.AWAITING_APPROVAL, S.BUILDING], to: S.ABORTED },
  fail: { from: [S.DEBATING, S.BUILDING], to: S.ERROR },
  rollback: { from: [S.DONE, S.ABORTED, S.ERROR], to: S.IDLE },
  reset: { from: [S.DONE, S.ABORTED, S.ERROR, S.AWAITING_APPROVAL], to: S.IDLE },
};

const MODE_OF = {
  [S.IDLE]: 'PLANNING',
  [S.DEBATING]: 'PLANNING',
  [S.AWAITING_APPROVAL]: 'PLANNING',
  [S.BUILDING]: 'CODING',
  [S.DONE]: 'CODING',
};

/**
 * Single source of truth for the session. The TUI and the Telegram bridge both
 * subscribe to 'state'; any action from either side goes through transition(), so
 * a second, conflicting action (e.g. a double approve) is rejected.
 *
 * Events:
 *   state        (snapshot, { action, from, source })
 *   agents       (agents map)
 *   chunk        ({ agent, label, role, kind, text })
 *   log          ({ level, text })
 */
export class StateMachine extends EventEmitter {
  constructor({ chief, workers = [], agents = {} } = {}) {
    super();
    this.setMaxListeners(50);
    this.status = S.IDLE;
    this.mode = 'PLANNING';
    this.sessionId = null;
    this.prompt = null;
    this.plan = null;
    this.tasks = [];
    this.diff = null;
    this.snapshotSha = null;
    this.error = null;
    this.chief = chief;
    this.workers = workers;
    this.agents = agents; // id -> { label, status, model, effort, note }
    this.logHistory = [];
  }

  can(action) {
    const t = TRANSITIONS[action];
    return Boolean(t && t.from.includes(this.status));
  }

  /** Apply an action. Returns false (and changes nothing) if it is not valid now. */
  transition(action, patch = {}, source = 'system') {
    if (!this.can(action)) return false;
    const from = this.status;
    this.status = TRANSITIONS[action].to;
    if (action === 'submit') {
      this.sessionId = crypto.randomBytes(4).toString('hex');
      this.plan = null;
      this.tasks = [];
      this.diff = null;
      this.error = null;
    }
    Object.assign(this, patch);
    this.mode = MODE_OF[this.status] ?? this.mode;
    this.emit('state', this.snapshot(), { action, from, source });
    return true;
  }

  update(patch) {
    Object.assign(this, patch);
    this.emit('state', this.snapshot(), { action: 'update', from: this.status, source: 'system' });
  }

  setAgent(id, patch) {
    this.agents[id] = { ...this.agents[id], ...patch };
    this.emit('agents', { ...this.agents });
  }

  chunk(payload) {
    this.emit('chunk', payload);
  }

  log(text, level = 'info') {
    const entry = { level, text };
    // Kept so UIs that subscribe late (e.g. after startup warnings) can replay them.
    this.logHistory.push(entry);
    if (this.logHistory.length > 50) this.logHistory.shift();
    this.emit('log', entry);
  }

  get busy() {
    return this.status === S.DEBATING || this.status === S.BUILDING;
  }

  snapshot() {
    return {
      status: this.status,
      mode: this.mode,
      sessionId: this.sessionId,
      prompt: this.prompt,
      plan: this.plan,
      tasks: this.tasks,
      diff: this.diff,
      snapshotSha: this.snapshotSha,
      error: this.error,
      chief: this.chief,
      workers: [...this.workers],
      agents: { ...this.agents },
    };
  }
}
