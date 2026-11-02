import path from 'node:path';
import { AgentError, ErrorType } from '../adapters/base-adapter.js';
import { ArchPlanSchema, ClarifySchema, ReviewSchema, TaskListSchema, normalizeRel, parseFileEnvelope, parseWith } from './protocol.js';
import { WEB_EXT, detectSite, findBrowser, formatReport, inspectSite, previewIntent, problemCount, serveStatic, startNpm } from './preview.js';
import * as P from './prompts.js';
import { PERMISSION_MODES, Status } from './state-machine.js';
import { t, tn } from '../i18n/index.js';

const COOLDOWN_TYPES = new Set([ErrorType.RATE_LIMIT, ErrorType.TIMEOUT, ErrorType.AUTH]);
const MENTION = /(?:^|\s)@([\w./\\-]*[\w/\\-])/g;

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };
const MAX_FINDINGS_PER_FILE = 12;

/** Findings from every reviewer, per file: most severe first, duplicates dropped. */
export function groupFindings(list) {
  const byFile = new Map();
  for (const f of list) {
    const arr = byFile.get(f.file) || [];
    if (!arr.some((x) => x.issue.trim().toLowerCase() === f.issue.trim().toLowerCase())) arr.push(f);
    byFile.set(f.file, arr);
  }
  for (const [file, arr] of byFile) byFile.set(file, arr.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]).slice(0, MAX_FINDINGS_PER_FILE));
  return byFile;
}

const severityText = (list) =>
  ['high', 'medium', 'low']
    .map((s) => [s, list.filter((f) => f.severity === s).length])
    .filter(([, n]) => n)
    .map(([s, n]) => `${n} ${t(s)}`)
    .join(' · ');

/** `@path` tokens in a prompt, in order, without duplicates. */
export function parseMentions(text) {
  const out = [];
  for (const m of String(text || '').matchAll(MENTION)) {
    const p = normalizeRel(m[1]);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * Chief/worker orchestration for the two-phase loop. All conversation state lives
 * here (request, tree, transcript, plan), and every CLI call is stateless with full
 * context, so handing the chief role to another agent mid-session loses nothing.
 */
export class Orchestrator {
  constructor({ config, workspace, pool, adapters, sm, history = () => [], onUsage = () => {} }) {
    this.config = config;
    this.workspace = workspace;
    this.pool = pool;
    this.adapters = adapters;
    this.sm = sm;
    this.cooldownUntil = new Map();
    this.unavailable = new Set();
    this.controller = null;
    this.ctx = null; // planning context of the current turn (request, tree, transcript)
    this.history = history; // earlier turns of the conversation, for follow-up requests
    this.summary = () => null; // /compact summary of turns before those
    this.compacting = false;
    this.onUsage = onUsage;
  }

  // ---------------------------------------------------------------- actions

  /**
   * New request. `kind` skips the chief's triage: 'task' (/plan) always plans code,
   * 'question' (/ask) always asks every agent.
   */
  submit(prompt, source = 'tui', { kind = null } = {}) {
    const text = String(prompt || '').trim();
    if (!text) return { ok: false, reason: t('Empty prompt') };
    if (this.compacting) return { ok: false, reason: t('Compacting the context, try again when it is done') };
    if (!this.sm.transition('submit', { prompt: text, snapshotSha: null }, source)) {
      return { ok: false, reason: `${t('A new task cannot start right now')} (${this.sm.status})` };
    }
    this.#spawnPhase(() => this.#runPlanning({ kind }));
    return { ok: true };
  }

  replan(feedback = '', source = 'tui') {
    const previousPlan = this.sm.plan;
    if (!this.sm.transition('replan', { feedback: feedback || null }, source)) return { ok: false, reason: `${t('Cannot replan')} (${this.sm.status})` };
    this.#spawnPhase(() => this.#runPlanning({ previousPlan, feedback }));
    return { ok: true };
  }

  approve(source = 'tui') {
    if (this.sm.status === Status.AWAITING_APPROVAL && !this.sm.plan?.files_to_modify?.length) {
      // Nothing to build: skip snapshot + decomposition (which would fail on zero tasks).
      this.sm.transition('noop', {}, source);
      this.sm.log('The plan changes no files, nothing to apply.', 'debug');
      return { ok: true, noop: true };
    }
    if (!this.sm.transition('approve', {}, source)) return { ok: false, reason: `${t('No plan to approve')} (${this.sm.status})` };
    // Like Claude Code, approving a plan leaves plan mode (for this session only).
    if (this.sm.permissionMode === 'plan') this.setPermissionMode('default');
    this.#spawnPhase(() => this.#runCoding());
    return { ok: true };
  }

  /**
   * Answer one of the chief's clarifying questions (from the TUI or Telegram, in any
   * order). Once all are answered the plan is drafted with the answers.
   */
  answerQuestion(index, answer, source = 'tui') {
    if (this.sm.status !== Status.AWAITING_ANSWERS) return { ok: false, reason: `${t('No questions waiting for answers')} (${this.sm.status})` };
    const qs = this.sm.questions || [];
    if (!(index >= 0 && index < qs.length)) return { ok: false, reason: t('No such question') };
    const value = Array.isArray(answer) ? answer.map(String).filter(Boolean) : String(answer ?? '').trim();
    if (!value.length) return { ok: false, reason: t('Empty answer') };
    const answers = [...this.sm.answers];
    answers[index] = value;
    this.sm.update({ answers });
    if (qs.every((_, i) => answers[i] != null)) {
      this.sm.transition('answered', {}, source);
      this.#spawnPhase(() => this.#runPlanning({ kind: 'task' }));
    }
    return { ok: true, done: this.sm.status !== Status.AWAITING_ANSWERS };
  }

  /** Answer every question at once (the TUI's review tab). */
  answerQuestions(list, source = 'tui') {
    if (this.sm.status !== Status.AWAITING_ANSWERS) return { ok: false, reason: `${t('No questions waiting for answers')} (${this.sm.status})` };
    const qs = this.sm.questions || [];
    const answers = qs.map((_, i) => {
      const a = list[i];
      const v = Array.isArray(a) ? a.map(String).filter(Boolean) : String(a ?? '').trim();
      return v.length ? v : null;
    });
    if (answers.some((a) => a == null)) return { ok: false, reason: t('Every question needs an answer') };
    this.sm.update({ answers });
    this.sm.transition('answered', {}, source);
    this.#spawnPhase(() => this.#runPlanning({ kind: 'task' }));
    return { ok: true, done: true };
  }

  /** Index of the first unanswered question, or -1. */
  get openQuestion() {
    if (this.sm.status !== Status.AWAITING_ANSWERS) return -1;
    return (this.sm.questions || []).findIndex((_, i) => this.sm.answers[i] == null);
  }

  cancel(source = 'tui') {
    if (this.sm.busy) return this.abort(source);
    if (this.sm.can('cancel')) {
      this.sm.transition('cancel', { plan: null }, source);
      return { ok: true };
    }
    if (this.sm.can('reset')) {
      this.sm.transition('reset', { snapshotSha: null, diff: null }, source);
      return { ok: true };
    }
    return { ok: false, reason: `${t('Nothing to cancel')} (${this.sm.status})` };
  }

  abort(source = 'tui') {
    this.controller?.abort(new Error('aborted'));
    const killed = this.pool.killAll();
    if (!this.sm.transition('abort', { error: t('Stopped by the user') }, source)) {
      return { ok: false, reason: `${t('Nothing is running')} (${this.sm.status})` };
    }
    this.sm.log(t('Emergency stop: {n} processes ended ({source})', { n: killed, source }), 'warn');
    return { ok: true, killed };
  }

  async rollback(source = 'tui') {
    const sha = this.sm.snapshotSha;
    if (!this.sm.can('rollback') || !sha) return { ok: false, reason: t('No snapshot to undo') };
    try {
      await this.workspace.rollback(sha);
    } catch (err) {
      this.sm.log(`${t('Undo failed')}: ${err.message}`, 'error');
      return { ok: false, reason: err.message };
    }
    this.sm.transition('rollback', { snapshotSha: null, diff: null }, source);
    this.sm.log(`Changes undone → ${sha.slice(0, 8)}`, 'debug');
    return { ok: true, sha };
  }

  /** Accept the result of a finished build (drops the rollback point). */
  accept(source = 'tui') {
    if (this.sm.status !== Status.DONE) return { ok: false, reason: t('No result to accept') };
    this.sm.transition('reset', { snapshotSha: null }, source);
    return { ok: true };
  }

  setChief(id) {
    if (this.sm.busy) return { ok: false, reason: t('The chief cannot change while agents are working') };
    if (!this.adapters[id]) return { ok: false, reason: `${t('No such agent')}: ${id}` };
    const old = this.sm.chief;
    if (old === id) return { ok: true };
    const workers = this.sm.workers.filter((w) => w !== id);
    if (old && !workers.includes(old)) workers.unshift(old);
    this.sm.update({ chief: id, workers });
    return { ok: true };
  }

  setPermissionMode(mode) {
    if (!PERMISSION_MODES.includes(mode)) return { ok: false, reason: `${t('Unknown mode')}: ${mode} (${PERMISSION_MODES.join(', ')})` };
    this.sm.update({ permissionMode: mode });
    return { ok: true };
  }

  cyclePermissionMode() {
    const i = PERMISSION_MODES.indexOf(this.sm.permissionMode);
    return this.setPermissionMode(PERMISSION_MODES[(i + 1) % PERMISSION_MODES.length]);
  }

  /**
   * What runs after coding, shown with the plan so approving it covers it:
   * { review: cross review on, site: null | 'static' | 'npm' (npm install + dev server) }.
   */
  afterCoding(plan) {
    const files = (plan?.files_to_modify || []).map(normalizeRel);
    const review = this.config.review?.enabled !== false && files.length > 0 && this.#reviewers().length > 1;
    let site = this.config.preview?.enabled !== false ? previewIntent(this.workspace.root, files) : null;
    if (site === 'npm' && this.config.preview?.npm === false) site = null;
    return { review, site };
  }

  updateAgent(id, patch) {
    const a = this.adapters[id];
    if (!a) return { ok: false, reason: `${t('No such agent')}: ${id}` };
    Object.assign(a.cfg, patch);
    this.sm.setAgent(id, patch);
    return { ok: true };
  }

  shutdown() {
    this.controller?.abort(new Error('shutdown'));
    this.pool.killAll();
  }

  // ---------------------------------------------------------------- helpers

  #spawnPhase(fn) {
    const controller = (this.controller = new AbortController());
    const sid = this.sm.turnId;
    fn().catch((err) => {
      if (this.sm.turnId !== sid || controller.signal.aborted) return;
      if (err instanceof AgentError && err.type === ErrorType.ABORTED) return;
      this.sm.log(err.message, 'error');
      this.sm.transition('fail', { error: err.message });
    });
  }

  #guard(sid, signal) {
    if (signal.aborted || this.sm.turnId !== sid) {
      throw new AgentError(ErrorType.ABORTED, t('Cancelled'));
    }
  }

  isAvailable(id) {
    if (!this.adapters[id] || this.unavailable.has(id)) return false;
    return (this.cooldownUntil.get(id) || 0) <= Date.now();
  }

  availableWorkers(exclude = []) {
    return this.sm.workers.filter((w) => !exclude.includes(w) && this.isAvailable(w));
  }

  /** Everyone who can review right now: the chief and the workers. */
  #reviewers() {
    return [this.sm.chief, ...this.sm.workers].filter((id, i, arr) => id && arr.indexOf(id) === i && this.isAvailable(id));
  }

  #label(id) {
    return this.adapters[id]?.label || id;
  }

  #penalize(id, err) {
    if (err.type === ErrorType.NOT_FOUND || err.type === ErrorType.POLICY) {
      // A CLI that tried to write on its own is not trusted again this run.
      this.unavailable.add(id);
      this.sm.setAgent(id, { status: 'unavailable', note: err.type === ErrorType.POLICY ? t('policy violation') : t('CLI not found') });
    } else if (COOLDOWN_TYPES.has(err.type)) {
      this.cooldownUntil.set(id, Date.now() + this.config.agentCooldownMs);
      this.sm.setAgent(id, { status: 'cooldown', note: err.type });
      setTimeout(() => {
        if (this.isAvailable(id)) this.sm.setAgent(id, { status: 'idle', note: null });
      }, this.config.agentCooldownMs).unref?.();
    } else {
      this.sm.setAgent(id, { status: 'idle', note: err.type });
    }
  }

  /**
   * `step` tags what the call is for (draft, critique, revise, synthesize, decompose,
   * code, repair) so UIs can decide what to show; it rides along on every chunk.
   */
  async callAgent(id, prompt, { role = 'worker', mode = 'PLANNING', step = null, meta = null, signal, images = [] } = {}) {
    const adapter = this.adapters[id];
    const label = adapter.label;
    const base = { agent: id, label, role, mode, step, meta };
    this.sm.setAgent(id, { status: 'busy', note: null });
    this.sm.chunk({ ...base, kind: 'start', text: '' });
    try {
      const res = await adapter.run({
        prompt,
        system: P.baseSystem(),
        mode,
        signal,
        images,
        onChunk: ({ kind, text }) => this.sm.chunk({ ...base, kind, text }),
      });
      this.sm.setAgent(id, {
        status: 'idle',
        ...(res.model ? { resolvedModel: res.model } : {}),
        ...(res.rateLimit ? { limits: { ...res.rateLimit, at: Date.now() } } : {}),
      });
      if (res.usage) this.onUsage(id, res.usage);
      this.sm.chunk({ ...base, kind: 'end', text: '', final: res.text, durationMs: res.durationMs, usage: res.usage, model: res.model });
      return res.text;
    } catch (err) {
      let e = err instanceof AgentError ? err : new AgentError(ErrorType.CRASH, err.message, { agent: id });
      if (signal?.aborted && e.type !== ErrorType.ABORTED) e = new AgentError(ErrorType.ABORTED, t('Cancelled'), { agent: id });
      if (e.type === ErrorType.ABORTED) {
        this.sm.setAgent(id, { status: 'idle' });
      } else {
        this.#penalize(id, e);
        this.sm.chunk({ ...base, kind: 'error', text: `${e.type}: ${e.message}\n` });
      }
      throw e;
    }
  }

  /** Call the chief; on failure hand the chief role to the fallback and retry the same prompt. */
  async callChief(prompt, { mode = 'PLANNING', step = null, signal } = {}) {
    const tried = new Set();
    for (;;) {
      const chief = this.sm.chief;
      tried.add(chief);
      try {
        if (!this.isAvailable(chief)) throw new AgentError(ErrorType.RATE_LIMIT, t('{name} is not available right now', { name: chief }), { agent: chief });
        return await this.callAgent(chief, prompt, { role: 'chief', mode, step, signal });
      } catch (err) {
        if (err.type === ErrorType.ABORTED || signal?.aborted) throw err;
        const next = this.#pickFallbackChief(tried);
        if (!next) throw new Error(`${t('The chief failed and no agent can take over')}: ${err.message}`);
        const workers = this.sm.workers.filter((w) => w !== next);
        if (!workers.includes(chief) && this.adapters[chief]) workers.push(chief);
        this.sm.update({ chief: next, workers });
        this.sm.emit('failover', { from: chief, to: next, reason: err.type, message: err.message });
        this.sm.log(`Chief handed over: ${chief} → ${next} (${err.type})`, 'debug');
      }
    }
  }

  #pickFallbackChief(tried) {
    const fb = this.config.fallbackChief;
    if (fb && !tried.has(fb) && this.isAvailable(fb)) return fb;
    return this.sm.workers.find((w) => !tried.has(w) && this.isAvailable(w)) || null;
  }

  async #chiefJson(prompt, schema, { shape, signal, mode, step } = {}) {
    const text = await this.callChief(prompt, { signal, mode, step });
    try {
      return parseWith(schema, text);
    } catch (err) {
      this.sm.log(`${t('Could not parse the chief’s output, asking for a repair')}: ${err.message}`, 'warn');
      const fixed = await this.callChief(P.repairJson({ badOutput: text, error: err.message, shape }), { signal, mode, step: 'repair' });
      return parseWith(schema, fixed);
    }
  }

  // ---------------------------------------------------------------- phase 1

  async #runPlanning({ previousPlan, feedback, kind: forced = null }) {
    const sid = this.sm.turnId;
    const { signal } = this.controller;
    const tree = await this.workspace.tree();
    const request = {
      text: this.sm.prompt,
      tree,
      history: this.history(sid),
      summary: this.summary(),
      mentions: await this.#mentions(this.sm.prompt, feedback),
      answers: P.formatAnswers(this.sm.questions || [], this.sm.answers),
    };
    const transcript = [];
    this.ctx = { request, tree, transcript };
    const opts = { signal, mode: 'PLANNING' };
    const rounds = Math.max(1, this.config.debateRounds);

    // Triage: the chief's first call also says whether this is chat, a question or a task.
    let draft;
    let kind = 'task';
    if (previousPlan || forced === 'task' || this.config.triage === false) {
      draft = await this.callChief(P.chiefDraft({ request, tree, previousPlan, feedback }), { ...opts, step: 'draft' });
    } else if (forced === 'question') {
      kind = 'question';
      draft = await this.callChief(P.answerQuestion({ request, tree, label: this.adapters[this.sm.chief].label }), { ...opts, step: 'solve' });
    } else {
      ({ kind, text: draft } = P.parseTriage(await this.callChief(P.chiefTriage({ request, tree }), { ...opts, step: 'triage' })));
    }
    this.#guard(sid, signal);
    if (kind === 'clarify') {
      let questions = null;
      try {
        ({ questions } = parseWith(ClarifySchema, draft));
      } catch (err) {
        this.sm.log(`Could not read the chief's questions (${err.message}), planning directly`, 'debug');
      }
      if (questions) {
        this.sm.kind = 'task';
        this.sm.emit('triage', { kind: 'clarify', turnId: sid });
        this.sm.transition('clarify', { questions, answers: [] });
        return;
      }
      kind = 'task';
      draft = await this.callChief(P.chiefDraft({ request, tree }), { ...opts, step: 'draft' });
      this.#guard(sid, signal);
    }
    this.sm.kind = kind;
    this.sm.emit('triage', { kind, turnId: sid });
    if (kind === 'chat') {
      this.sm.transition('answer', { answer: draft, kind });
      return;
    }
    if (kind === 'question') return this.#answer({ request, tree, own: draft, sid, opts });
    transcript.push({ agent: this.sm.chief, label: this.adapters[this.sm.chief].label, role: 'chief', round: 1, text: draft });

    for (let round = 1; round <= rounds; round++) {
      const workers = this.availableWorkers([this.sm.chief]);
      if (!workers.length) {
        this.sm.log(t('No worker available, the chief plans alone'), 'warn');
        break;
      }
      const results = await Promise.allSettled(
        workers.map((w) =>
          this.callAgent(w, P.workerCritique({ request, tree, draft, label: this.adapters[w].label, round, transcript }), {
            role: 'worker',
            step: 'critique',
            ...opts,
          }),
        ),
      );
      this.#guard(sid, signal);
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          transcript.push({ agent: workers[i], label: this.adapters[workers[i]].label, role: 'worker', round, text: r.value });
        } else {
          this.sm.log(`${t('{name} could not join the debate', { name: workers[i] })}: ${r.reason?.message}`, 'warn');
        }
      });
      if (round < rounds) {
        draft = await this.callChief(P.chiefRevise({ request, tree, draft, transcript, round }), { ...opts, step: 'revise' });
        this.#guard(sid, signal);
        transcript.push({ agent: this.sm.chief, label: this.adapters[this.sm.chief].label, role: 'chief', round: round + 1, text: draft });
      }
    }

    const plan = await this.#chiefJson(P.chiefSynthesize({ request, tree, draft, transcript }), ArchPlanSchema, {
      shape: P.SHAPES.ARCH_PLAN,
      step: 'synthesize',
      ...opts,
    });
    this.#guard(sid, signal);
    plan.after = this.afterCoding(plan);
    this.sm.transition('planReady', { plan });
    // "auto" mode codes right away unless the chief needs answers or found nothing to change.
    if (this.sm.permissionMode === 'auto' && plan.files_to_modify.length && !plan.questions?.length) this.approve('auto');
  }

  /** A question: every available worker answers on its own, the chief reconciles. */
  async #answer({ request, tree, own, sid, opts }) {
    const { signal } = opts;
    const workers = this.availableWorkers([this.sm.chief]);
    const results = await Promise.allSettled(
      workers.map((w) => this.callAgent(w, P.answerQuestion({ request, tree, label: this.adapters[w].label }), { role: 'worker', step: 'answer', ...opts })),
    );
    this.#guard(sid, signal);
    const answers = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value.trim()) answers.push({ label: this.adapters[workers[i]].label, text: r.value });
      else if (r.status === 'rejected') this.sm.log(`${t('{name} could not answer', { name: workers[i] })}: ${r.reason?.message}`, 'warn');
    });
    const final = answers.length ? await this.callChief(P.chiefAnswer({ request, own, answers }), { ...opts, step: 'final' }) : own;
    this.#guard(sid, signal);
    this.sm.transition('answer', { answer: final.trim(), kind: 'question', answeredBy: 1 + answers.length });
  }

  /** Contents of `@file` mentions that exist in the workspace. */
  async #mentions(...texts) {
    const paths = parseMentions(texts.filter(Boolean).join(' ')).filter((p) => {
      try {
        this.workspace.resolveSafe(p);
        return this.workspace.exists(p);
      } catch {
        return false;
      }
    });
    return paths.length ? this.workspace.readSnippets(paths) : {};
  }

  // ---------------------------------------------------------------- phase 2

  async #runCoding() {
    const sid = this.sm.turnId;
    const { signal } = this.controller;
    const opts = { signal, mode: 'CODING' };
    const request = this.ctx?.request ?? { text: this.sm.prompt, history: this.history(sid), summary: this.summary(), mentions: {} };
    const plan = this.sm.plan;

    const sha = await this.workspace.snapshot(`pre-coding ${sid}`);
    this.sm.update({ snapshotSha: sha });
    this.sm.log(`Git snapshot taken: ${sha.slice(0, 8)}`, 'debug');

    const tree = this.ctx?.tree ?? (await this.workspace.tree());
    let workers = this.availableWorkers([this.sm.chief]);
    if (!workers.length) workers = [this.sm.chief];

    const { tasks: rawTasks } = await this.#chiefJson(P.chiefDecompose({ request, tree, plan, workers }), TaskListSchema, {
      ...opts,
      step: 'decompose',
    });
    this.#guard(sid, signal);

    const tasks = [];
    rawTasks.forEach((raw, i) => {
      const file_path = normalizeRel(raw.file_path);
      try {
        this.workspace.resolveSafe(file_path);
      } catch (err) {
        this.sm.log(`${t('Task skipped ({path})', { path: file_path })}: ${err.message}`, 'error');
        return;
      }
      const target_worker = this.adapters[raw.target_worker] ? raw.target_worker : workers[i % workers.length];
      tasks.push({ ...raw, file_path, target_worker, status: 'pending', worker: null });
    });
    if (!tasks.length) throw new Error(t('The chief produced no valid task'));
    this.sm.update({ tasks });

    // Parallel across files, sequential for tasks that touch the same file.
    const groups = new Map();
    tasks.forEach((t, i) => {
      const key = t.file_path.toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    });
    await Promise.all(
      [...groups.values()].map(async (idxs) => {
        for (const i of idxs) await this.#runTask(i, { request, plan, tree, sid, ...opts });
      }),
    );
    this.#guard(sid, signal);

    // Everyone checks everyone's code, then (for a site) uses it; the owners apply the findings.
    // A failing review step never loses the code that was written.
    const ctx = { request, plan, sid, ...opts };
    for (const step of [() => this.#reviewCode(ctx), () => this.#checkSite(ctx)]) {
      try {
        await step();
      } catch (err) {
        if (err.type === ErrorType.ABORTED || signal.aborted) throw err;
        this.sm.log(`${t('Review step failed')}: ${err.message}`, 'warn');
      }
      this.#guard(sid, signal);
    }

    const diff = await this.workspace.diffSummary(sha);
    const failed = this.sm.tasks.filter((t) => t.status === 'failed').length;
    if (failed) this.sm.log(t('{n} task(s) could not be finished', { n: failed }), 'error');
    this.sm.transition('buildDone', { diff, error: failed ? t('{n} task(s) failed', { n: failed }) : null });
  }

  // ---------------------------------------------------------------- review

  /** Each agent reviews the files the others wrote; the author of each file applies the findings. */
  async #reviewCode({ request, plan, sid, signal, mode }) {
    const cfg = this.config.review || {};
    if (cfg.enabled === false) return;
    const summary = { findings: 0, fixed: [], rounds: 0 };
    for (let round = 1; round <= Math.max(1, cfg.rounds ?? 1); round++) {
      const files = [];
      for (const task of this.sm.tasks.filter((x) => x.status === 'done')) {
        const content = await this.workspace.readFile(task.file_path).catch(() => null);
        if (content != null) files.push({ path: task.file_path, author: task.worker, authorLabel: this.#label(task.worker), content });
      }
      const jobs = this.#reviewers()
        .map((id) => ({ id, files: files.filter((f) => f.author !== id) }))
        .filter((j) => j.files.length);
      if (!jobs.length) return; // a single agent has nobody else's code to review
      this.sm.note({ kind: 'phase', text: round > 1 ? t('Cross review, round {n}', { n: round }) : t('Cross review'), detail: t('everyone reviews the others’ code: {names}', { names: jobs.map((j) => this.#label(j.id)).join(', ') }) });
      const lists = await Promise.all(
        jobs.map((j) => this.#findings(j.id, P.codeReview({ request, plan, files: j.files, label: this.#label(j.id) }), { step: 'review', allowed: j.files.map((x) => x.path), signal, mode })),
      );
      this.#guard(sid, signal);
      const all = lists.flat();
      const byFile = groupFindings(all);
      summary.rounds = round;
      summary.findings += all.length;
      this.sm.update({ review: { ...summary } });
      if (!byFile.size) {
        this.sm.note({ kind: 'phase', color: 'green', text: t('Review: no problems found') });
        return;
      }
      this.sm.note({ kind: 'phase', text: t('Review: {n} findings in {files}', { n: all.length, files: tn(byFile.size, '{n} file', '{n} files') }), detail: severityText(all), findings: [...byFile.values()].flat() });
      const authors = new Map(this.sm.tasks.map((x) => [x.file_path, x.worker]));
      const fixed = await this.#applyFindings(byFile, { authors, request, plan, sid, signal, mode });
      summary.fixed = [...new Set([...summary.fixed, ...fixed])];
      this.sm.update({ review: { ...summary } });
      if (!fixed.length) return;
    }
  }

  /** Ask one agent for findings; anything unparseable counts as none (the review is best-effort). */
  async #findings(id, prompt, { step, allowed, fallback = null, images = [], signal, mode }) {
    try {
      const text = await this.callAgent(id, prompt, { role: 'worker', mode, step, signal, images });
      const { findings } = parseWith(ReviewSchema, text);
      const known = new Map(allowed.map((p) => [p.toLowerCase(), p]));
      return findings
        .map((f) => ({ ...f, file: known.get(normalizeRel(f.file).toLowerCase()) || fallback, by: this.#label(id) }))
        .filter((f) => f.file && f.issue.trim());
    } catch (err) {
      if (err.type === ErrorType.ABORTED || signal.aborted) throw err;
      this.sm.log(`${this.#label(id)}: ${t('review skipped')} (${err.message.slice(0, 160)})`, 'warn');
      return [];
    }
  }

  /** The file's author (or a backup) rewrites it with the findings applied. Returns the changed paths. */
  async #applyFindings(byFile, { authors, request, plan, sid, signal, mode }) {
    const changed = await Promise.all(
      [...byFile].map(async ([file, findings]) => {
        const content = await this.workspace.readFile(file).catch(() => null);
        if (content == null) return null;
        const candidates = [authors.get(file), ...this.sm.workers, this.sm.chief].filter((w, k, arr) => w && arr.indexOf(w) === k);
        for (const worker of candidates) {
          this.#guard(sid, signal);
          if (!this.isAvailable(worker)) continue;
          try {
            const text = await this.callAgent(worker, P.fixFile({ request, plan, path: file, content, findings }), { role: 'worker', mode, step: 'fix', meta: { file, action: 'fix' }, signal });
            this.#guard(sid, signal);
            const files = parseFileEnvelope(text);
            const match = files.find((x) => normalizeRel(x.path).toLowerCase() === file.toLowerCase()) || (files.length === 1 ? files[0] : null);
            if (!match) {
              if (/\bNO_CHANGES\b/.test(text)) return null;
              throw new AgentError(ErrorType.CRASH, t('{name} did not produce the expected file envelope', { name: worker }), { agent: worker });
            }
            if (match.content === content) return null;
            await this.workspace.writeFile(file, match.content);
            const lines = match.content.split('\n').length - (match.content.endsWith('\n') ? 1 : 0);
            this.sm.note({ kind: 'fix', task: { file_path: file, action: 'fix', status: 'done', worker, workerLabel: this.#label(worker), lines, findings: findings.length } });
            return file;
          } catch (err) {
            if (err.type === ErrorType.ABORTED || signal.aborted) throw err;
            this.sm.log(`✖ ${file} @ ${worker}: ${err.message}. ${t('Handing it to a backup worker')}`, 'warn');
          }
        }
        return null;
      }),
    );
    return changed.filter(Boolean);
  }

  /**
   * Web projects: KERBEROS serves the site (its own static server, or npm install + the
   * dev server; approving the plan covered that), uses it in a headless browser, and every
   * agent reviews the screenshots and the automatic check. Fixes go to the files' owners,
   * then the site is checked once more so the user gets the final screenshots.
   */
  async #checkSite({ request, plan, sid, signal, mode }) {
    const cfg = this.config.preview || {};
    if (cfg.enabled === false) return;
    const done = this.sm.tasks.filter((x) => x.status === 'done');
    const changed = done.map((x) => x.file_path);
    const site = detectSite(this.workspace.root, changed);
    if (!site) return;
    if (site.kind === 'npm' && cfg.npm === false) {
      this.sm.log(t('Site check skipped: npm projects are turned off (preview.npm)'));
      return;
    }
    const bin = findBrowser(cfg.browser);
    if (!bin) {
      this.sm.log(t('Site check skipped: no Chrome or Edge found (set preview.browser)'), 'warn');
      return;
    }
    const log = (text) => this.sm.log(text, 'debug');
    this.sm.note({ kind: 'phase', text: t('Site check'), detail: site.kind === 'npm' ? `${site.install ? 'npm install · ' : ''}npm run ${site.script}` : t('static site, served by KERBEROS') });

    let server = null;
    try {
      server = site.kind === 'npm' ? await startNpm(this.workspace.root, { ...site, pool: this.pool, signal, log, installTimeoutMs: cfg.installTimeoutMs, startTimeoutMs: cfg.startTimeoutMs }) : await serveStatic(site.root);
      this.#guard(sid, signal);
      const url = server.url + (site.entry && site.entry !== '/' ? site.entry : '');
      const files = (await this.workspace.listFiles(3000)).filter((p) => WEB_EXT.test(p)).slice(0, 300);
      const fallback = changed.find((p) => /\.css$/i.test(p)) || changed.find((p) => /\.html?$/i.test(p)) || changed.find((p) => WEB_EXT.test(p)) || null;
      const authors = new Map(done.map((x) => [x.file_path, x.worker]));
      const outDir = (name) => path.join(this.workspace.stateDir, 'preview', sid, name);
      const inspect = (name) => inspectSite(url, { bin, outDir: outDir(name), pages: cfg.pages ?? 4, pool: this.pool, signal, log });
      const rounds = Math.max(1, cfg.rounds ?? 1);

      let report = await inspect('r1');
      for (let round = 1; round <= rounds; round++) {
        this.#guard(sid, signal);
        this.sm.note({ kind: 'preview', report, root: this.workspace.root });
        const shots = report.shots.map((s) => s.file);
        const text = formatReport(report, { root: this.workspace.root });
        const reviewers = this.#reviewers();
        this.sm.note({ kind: 'phase', text: t('Everyone reviews the site'), detail: reviewers.map((id) => this.#label(id)).join(', ') });
        const lists = await Promise.all(
          reviewers.map((id) => this.#findings(id, P.siteReview({ request, report: text, shots, files, label: this.#label(id) }), { step: 'visual', allowed: files, fallback, images: shots, signal, mode })),
        );
        this.#guard(sid, signal);
        const all = lists.flat();
        const byFile = groupFindings(all);
        if (!byFile.size) {
          this.sm.note({ kind: 'phase', color: 'green', text: t('Site review: nothing to improve') });
          break;
        }
        this.sm.note({ kind: 'phase', text: t('Site review: {n} findings in {files}', { n: all.length, files: tn(byFile.size, '{n} file', '{n} files') }), detail: severityText(all), findings: [...byFile.values()].flat() });
        const fixed = await this.#applyFindings(byFile, { authors, request, plan, sid, signal, mode });
        if (!fixed.length) break;
        // npm dev servers reload by themselves; the static server reads files fresh.
        report = await inspect(round === rounds ? 'final' : `r${round + 1}`);
        if (round === rounds) this.sm.note({ kind: 'preview', report, root: this.workspace.root, final: true });
      }
      const dir = report.shots[0] ? path.relative(this.workspace.root, path.dirname(report.shots[0].file)).split(path.sep).join('/') : null;
      this.sm.update({ preview: { url, kind: site.kind, problems: problemCount(report), shots: report.shots, dir } });
    } finally {
      await server?.close();
    }
  }

  #setTask(i, patch) {
    const tasks = this.sm.tasks.slice();
    tasks[i] = { ...tasks[i], ...patch };
    this.sm.update({ tasks });
  }

  async #runTask(i, { request, plan, tree, sid, signal, mode }) {
    const task = this.sm.tasks[i];
    const related = Object.keys(task.context_snippets || {}).map(normalizeRel);
    const paths = task.action === 'update_file' ? [task.file_path, ...related] : related;
    const snippets = await this.workspace.readSnippets([...new Set(paths)]);
    const prompt = P.workerCode({ request, plan, task, snippets, tree });

    const candidates = [task.target_worker, ...this.sm.workers, this.sm.chief].filter((w, k, arr) => w && arr.indexOf(w) === k);
    for (const worker of candidates) {
      this.#guard(sid, signal);
      if (!this.isAvailable(worker)) continue;
      this.#setTask(i, { status: 'running', worker });
      try {
        const text = await this.callAgent(worker, prompt, { role: 'worker', mode, step: 'code', meta: { file: task.file_path, action: task.action }, signal });
        this.#guard(sid, signal);
        const files = parseFileEnvelope(text);
        const match = files.find((f) => normalizeRel(f.path).toLowerCase() === task.file_path.toLowerCase()) || (files.length === 1 ? files[0] : null);
        if (!match) throw new AgentError(ErrorType.CRASH, t('{name} did not produce the expected file envelope', { name: worker }), { agent: worker });
        if (normalizeRel(match.path) !== task.file_path) {
          this.sm.log(t('{name} wrote a different path ({got}); using the task’s path: {path}', { name: worker, got: match.path, path: task.file_path }), 'warn');
        }
        const existed = this.workspace.exists(task.file_path);
        await this.workspace.writeFile(task.file_path, match.content);
        const lines = match.content.split('\n').length - (match.content.endsWith('\n') ? 1 : 0);
        this.#setTask(i, { status: 'done', worker, lines, existed });
        this.sm.log(`✔ ${task.action} ${task.file_path} (${worker})`, 'debug');
        return;
      } catch (err) {
        if (err.type === ErrorType.ABORTED || signal.aborted) throw err;
        this.sm.log(`✖ ${task.file_path} @ ${worker}: ${err.message}. ${t('Handing it to a backup worker')}`, 'warn');
      }
    }
    this.#setTask(i, { status: 'failed' });
  }
}
