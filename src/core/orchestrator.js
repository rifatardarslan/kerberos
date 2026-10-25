import { AgentError, ErrorType } from '../adapters/base-adapter.js';
import { ArchPlanSchema, ClarifySchema, TaskListSchema, normalizeRel, parseFileEnvelope, parseWith } from './protocol.js';
import * as P from './prompts.js';
import { PERMISSION_MODES, Status } from './state-machine.js';

const COOLDOWN_TYPES = new Set([ErrorType.RATE_LIMIT, ErrorType.TIMEOUT, ErrorType.AUTH]);
const MENTION = /(?:^|\s)@([\w./\\-]*[\w/\\-])/g;

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
    if (!text) return { ok: false, reason: 'Boş prompt' };
    if (this.compacting) return { ok: false, reason: 'Bağlam sıkıştırılıyor, bitince tekrar deneyin' };
    if (!this.sm.transition('submit', { prompt: text, snapshotSha: null }, source)) {
      return { ok: false, reason: `Şu an yeni görev başlatılamaz (${this.sm.status})` };
    }
    this.#spawnPhase(() => this.#runPlanning({ kind }));
    return { ok: true };
  }

  replan(feedback = '', source = 'tui') {
    const previousPlan = this.sm.plan;
    if (!this.sm.transition('replan', { feedback: feedback || null }, source)) return { ok: false, reason: `Yeniden planlama yapılamaz (${this.sm.status})` };
    this.#spawnPhase(() => this.#runPlanning({ previousPlan, feedback }));
    return { ok: true };
  }

  approve(source = 'tui') {
    if (this.sm.status === Status.AWAITING_APPROVAL && !this.sm.plan?.files_to_modify?.length) {
      // Nothing to build: skip snapshot + decomposition (which would fail on zero tasks).
      this.sm.transition('noop', {}, source);
      this.sm.log('Plan dosya değişikliği içermiyor, uygulanacak bir şey yok. Yeni bir görev yazabilirsiniz.', 'debug');
      return { ok: true, noop: true };
    }
    if (!this.sm.transition('approve', {}, source)) return { ok: false, reason: `Onaylanacak plan yok (${this.sm.status})` };
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
    if (this.sm.status !== Status.AWAITING_ANSWERS) return { ok: false, reason: `Yanıt bekleyen soru yok (${this.sm.status})` };
    const qs = this.sm.questions || [];
    if (!(index >= 0 && index < qs.length)) return { ok: false, reason: 'Böyle bir soru yok' };
    const value = Array.isArray(answer) ? answer.map(String).filter(Boolean) : String(answer ?? '').trim();
    if (!value.length) return { ok: false, reason: 'Boş yanıt' };
    const answers = [...this.sm.answers];
    answers[index] = value;
    this.sm.update({ answers });
    if (qs.every((_, i) => answers[i] != null)) {
      this.sm.transition('answered', {}, source);
      this.#spawnPhase(() => this.#runPlanning({ kind: 'task' }));
    }
    return { ok: true, done: this.sm.status !== Status.AWAITING_ANSWERS };
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
    return { ok: false, reason: `İptal edilecek bir şey yok (${this.sm.status})` };
  }

  abort(source = 'tui') {
    this.controller?.abort(new Error('aborted'));
    const killed = this.pool.killAll();
    if (!this.sm.transition('abort', { error: 'Kullanıcı tarafından durduruldu' }, source)) {
      return { ok: false, reason: `Çalışan bir süreç yok (${this.sm.status})` };
    }
    this.sm.log(`Acil durdurma: ${killed} süreç sonlandırıldı (${source})`, 'warn');
    return { ok: true, killed };
  }

  async rollback(source = 'tui') {
    const sha = this.sm.snapshotSha;
    if (!this.sm.can('rollback') || !sha) return { ok: false, reason: 'Geri alınacak snapshot yok' };
    try {
      await this.workspace.rollback(sha);
    } catch (err) {
      this.sm.log(`Rollback başarısız: ${err.message}`, 'error');
      return { ok: false, reason: err.message };
    }
    this.sm.transition('rollback', { snapshotSha: null, diff: null }, source);
    this.sm.log(`Değişiklikler geri alındı → ${sha.slice(0, 8)}`, 'debug');
    return { ok: true, sha };
  }

  /** Accept the result of a finished build (drops the rollback point). */
  accept(source = 'tui') {
    if (this.sm.status !== Status.DONE) return { ok: false, reason: 'Kabul edilecek sonuç yok' };
    this.sm.transition('reset', { snapshotSha: null }, source);
    return { ok: true };
  }

  setChief(id) {
    if (this.sm.busy) return { ok: false, reason: 'Çalışırken şef değiştirilemez' };
    if (!this.adapters[id]) return { ok: false, reason: `Ajan yok: ${id}` };
    const old = this.sm.chief;
    if (old === id) return { ok: true };
    const workers = this.sm.workers.filter((w) => w !== id);
    if (old && !workers.includes(old)) workers.unshift(old);
    this.sm.update({ chief: id, workers });
    return { ok: true };
  }

  setPermissionMode(mode) {
    if (!PERMISSION_MODES.includes(mode)) return { ok: false, reason: `Bilinmeyen mod: ${mode} (${PERMISSION_MODES.join(', ')})` };
    this.sm.update({ permissionMode: mode });
    return { ok: true };
  }

  cyclePermissionMode() {
    const i = PERMISSION_MODES.indexOf(this.sm.permissionMode);
    return this.setPermissionMode(PERMISSION_MODES[(i + 1) % PERMISSION_MODES.length]);
  }

  updateAgent(id, patch) {
    const a = this.adapters[id];
    if (!a) return { ok: false, reason: `Ajan yok: ${id}` };
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
      throw new AgentError(ErrorType.ABORTED, 'İptal edildi');
    }
  }

  isAvailable(id) {
    if (!this.adapters[id] || this.unavailable.has(id)) return false;
    return (this.cooldownUntil.get(id) || 0) <= Date.now();
  }

  availableWorkers(exclude = []) {
    return this.sm.workers.filter((w) => !exclude.includes(w) && this.isAvailable(w));
  }

  #penalize(id, err) {
    if (err.type === ErrorType.NOT_FOUND || err.type === ErrorType.POLICY) {
      // A CLI that tried to write on its own is not trusted again this run.
      this.unavailable.add(id);
      this.sm.setAgent(id, { status: 'unavailable', note: err.type === ErrorType.POLICY ? 'güvenlik ihlali' : 'CLI bulunamadı' });
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
  async callAgent(id, prompt, { role = 'worker', mode = 'PLANNING', step = null, meta = null, signal } = {}) {
    const adapter = this.adapters[id];
    const label = adapter.label;
    const base = { agent: id, label, role, mode, step, meta };
    this.sm.setAgent(id, { status: 'busy', note: null });
    this.sm.chunk({ ...base, kind: 'start', text: '' });
    try {
      const res = await adapter.run({
        prompt,
        system: P.BASE_SYSTEM,
        mode,
        signal,
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
      if (signal?.aborted && e.type !== ErrorType.ABORTED) e = new AgentError(ErrorType.ABORTED, 'İptal edildi', { agent: id });
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
        if (!this.isAvailable(chief)) throw new AgentError(ErrorType.RATE_LIMIT, `${chief} şu an kullanılamıyor`, { agent: chief });
        return await this.callAgent(chief, prompt, { role: 'chief', mode, step, signal });
      } catch (err) {
        if (err.type === ErrorType.ABORTED || signal?.aborted) throw err;
        const next = this.#pickFallbackChief(tried);
        if (!next) throw new Error(`Şef başarısız ve devralacak ajan yok: ${err.message}`);
        const workers = this.sm.workers.filter((w) => w !== next);
        if (!workers.includes(chief) && this.adapters[chief]) workers.push(chief);
        this.sm.update({ chief: next, workers });
        this.sm.emit('failover', { from: chief, to: next, reason: err.type, message: err.message });
        this.sm.log(`Şeflik devredildi: ${chief} → ${next} (${err.type})`, 'debug');
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
      this.sm.log(`Şef çıktısı ayrıştırılamadı, onarım isteniyor: ${err.message}`, 'warn');
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
        this.sm.log(`Şefin soruları okunamadı (${err.message}), doğrudan planlanıyor`, 'debug');
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
        this.sm.log('Uygun işçi yok, plan yalnızca şef tarafından hazırlanıyor', 'warn');
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
          this.sm.log(`${workers[i]} tartışmaya katılamadı: ${r.reason?.message}`, 'warn');
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
      else if (r.status === 'rejected') this.sm.log(`${workers[i]} yanıt veremedi: ${r.reason?.message}`, 'warn');
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
    this.sm.log(`Git snapshot alındı: ${sha.slice(0, 8)}`, 'debug');

    const tree = this.ctx?.tree ?? (await this.workspace.tree());
    let workers = this.availableWorkers([this.sm.chief]);
    if (!workers.length) workers = [this.sm.chief];

    const { tasks: rawTasks } = await this.#chiefJson(P.chiefDecompose({ request, tree, plan, workers }), TaskListSchema, {
      ...opts,
      step: 'decompose',
    });
    this.#guard(sid, signal);

    const tasks = [];
    rawTasks.forEach((t, i) => {
      const file_path = normalizeRel(t.file_path);
      try {
        this.workspace.resolveSafe(file_path);
      } catch (err) {
        this.sm.log(`Görev atlandı (${file_path}): ${err.message}`, 'error');
        return;
      }
      const target_worker = this.adapters[t.target_worker] ? t.target_worker : workers[i % workers.length];
      tasks.push({ ...t, file_path, target_worker, status: 'pending', worker: null });
    });
    if (!tasks.length) throw new Error('Şef geçerli bir görev üretmedi');
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

    const diff = await this.workspace.diffSummary(sha);
    const failed = this.sm.tasks.filter((t) => t.status === 'failed').length;
    if (failed) this.sm.log(`${failed} görev tamamlanamadı`, 'error');
    this.sm.transition('buildDone', { diff, error: failed ? `${failed} görev başarısız` : null });
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
        if (!match) throw new AgentError(ErrorType.CRASH, `${worker} beklenen dosya zarfını üretmedi`, { agent: worker });
        if (normalizeRel(match.path) !== task.file_path) {
          this.sm.log(`${worker} farklı yol yazdı (${match.path}); görevdeki yol kullanılıyor: ${task.file_path}`, 'warn');
        }
        const existed = this.workspace.exists(task.file_path);
        await this.workspace.writeFile(task.file_path, match.content);
        const lines = match.content.split('\n').length - (match.content.endsWith('\n') ? 1 : 0);
        this.#setTask(i, { status: 'done', worker, lines, existed });
        this.sm.log(`✔ ${task.action} ${task.file_path} (${worker})`, 'debug');
        return;
      } catch (err) {
        if (err.type === ErrorType.ABORTED || signal.aborted) throw err;
        this.sm.log(`✖ ${task.file_path} @ ${worker}: ${err.message}. Yedek işçiye aktarılıyor`, 'warn');
      }
    }
    this.#setTask(i, { status: 'failed' });
  }
}
