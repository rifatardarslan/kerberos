import { AgentError, ErrorType } from '../adapters/base-adapter.js';
import { ArchPlanSchema, TaskListSchema, normalizeRel, parseFileEnvelope, parseWith } from './protocol.js';
import * as P from './prompts.js';
import { Status } from './state-machine.js';

const COOLDOWN_TYPES = new Set([ErrorType.RATE_LIMIT, ErrorType.TIMEOUT, ErrorType.AUTH]);

/**
 * Chief/worker orchestration for the two-phase loop. All conversation state lives
 * here (request, tree, transcript, plan), and every CLI call is stateless with full
 * context, so handing the chief role to another agent mid-session loses nothing.
 */
export class Orchestrator {
  constructor({ config, workspace, pool, adapters, sm }) {
    this.config = config;
    this.workspace = workspace;
    this.pool = pool;
    this.adapters = adapters;
    this.sm = sm;
    this.cooldownUntil = new Map();
    this.unavailable = new Set();
    this.controller = null;
    this.session = null;

    sm.on('state', (snap, meta) => {
      if (meta.action === 'update') return;
      this.workspace
        .saveSession({
          status: snap.status,
          sessionId: snap.sessionId,
          prompt: snap.prompt,
          plan: snap.plan,
          diff: snap.diff,
          snapshot: snap.snapshotSha,
        })
        .catch(() => {});
    });
  }

  // ---------------------------------------------------------------- actions

  submit(prompt, source = 'tui') {
    const text = String(prompt || '').trim();
    if (!text) return { ok: false, reason: 'Boş prompt' };
    if (!this.sm.transition('submit', { prompt: text, snapshotSha: null }, source)) {
      return { ok: false, reason: `Şu an yeni görev başlatılamaz (${this.sm.status})` };
    }
    this.#spawnPhase(() => this.#runPlanning({}));
    return { ok: true };
  }

  replan(feedback = '', source = 'tui') {
    const previousPlan = this.sm.plan;
    if (!this.sm.transition('replan', {}, source)) return { ok: false, reason: `Yeniden planlama yapılamaz (${this.sm.status})` };
    this.#spawnPhase(() => this.#runPlanning({ previousPlan, feedback }));
    return { ok: true };
  }

  approve(source = 'tui') {
    if (this.sm.status === Status.AWAITING_APPROVAL && !this.sm.plan?.files_to_modify?.length) {
      // Nothing to build: skip snapshot + decomposition (which would fail on zero tasks).
      this.sm.transition('noop', {}, source);
      this.sm.log('Plan dosya değişikliği içermiyor, uygulanacak bir şey yok. Yeni bir görev yazabilirsiniz.', 'warn');
      return { ok: true, noop: true };
    }
    if (!this.sm.transition('approve', {}, source)) return { ok: false, reason: `Onaylanacak plan yok (${this.sm.status})` };
    this.#spawnPhase(() => this.#runCoding());
    return { ok: true };
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
    this.sm.log(`Değişiklikler geri alındı → ${sha.slice(0, 8)}`, 'warn');
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
    const sid = this.sm.sessionId;
    fn().catch((err) => {
      if (this.sm.sessionId !== sid || controller.signal.aborted) return;
      if (err instanceof AgentError && err.type === ErrorType.ABORTED) return;
      this.sm.log(err.message, 'error');
      this.sm.transition('fail', { error: err.message });
    });
  }

  #guard(sid, signal) {
    if (signal.aborted || this.sm.sessionId !== sid) {
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
    if (err.type === ErrorType.NOT_FOUND) {
      this.unavailable.add(id);
      this.sm.setAgent(id, { status: 'unavailable', note: 'CLI bulunamadı' });
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

  async callAgent(id, prompt, { role = 'worker', mode = 'PLANNING', signal } = {}) {
    const adapter = this.adapters[id];
    const label = adapter.label;
    this.sm.setAgent(id, { status: 'busy', note: null });
    this.sm.chunk({ agent: id, label, role, kind: 'start', text: '' });
    try {
      const res = await adapter.run({
        prompt,
        system: P.BASE_SYSTEM,
        mode,
        signal,
        onChunk: ({ kind, text }) => this.sm.chunk({ agent: id, label, role, kind, text }),
      });
      this.sm.setAgent(id, { status: 'idle' });
      this.sm.chunk({ agent: id, label, role, kind: 'end', text: '' });
      return res.text;
    } catch (err) {
      let e = err instanceof AgentError ? err : new AgentError(ErrorType.CRASH, err.message, { agent: id });
      if (signal?.aborted && e.type !== ErrorType.ABORTED) e = new AgentError(ErrorType.ABORTED, 'İptal edildi', { agent: id });
      if (e.type === ErrorType.ABORTED) {
        this.sm.setAgent(id, { status: 'idle' });
      } else {
        this.#penalize(id, e);
        this.sm.chunk({ agent: id, label, role, kind: 'error', text: `${e.type}: ${e.message}\n` });
      }
      throw e;
    }
  }

  /** Call the chief; on failure hand the chief role to the fallback and retry the same prompt. */
  async callChief(prompt, { mode = 'PLANNING', signal } = {}) {
    const tried = new Set();
    for (;;) {
      const chief = this.sm.chief;
      tried.add(chief);
      try {
        if (!this.isAvailable(chief)) throw new AgentError(ErrorType.RATE_LIMIT, `${chief} şu an kullanılamıyor`, { agent: chief });
        return await this.callAgent(chief, prompt, { role: 'chief', mode, signal });
      } catch (err) {
        if (err.type === ErrorType.ABORTED || signal?.aborted) throw err;
        const next = this.#pickFallbackChief(tried);
        if (!next) throw new Error(`Şef başarısız ve devralacak ajan yok: ${err.message}`);
        const workers = this.sm.workers.filter((w) => w !== next);
        if (!workers.includes(chief) && this.adapters[chief]) workers.push(chief);
        this.sm.update({ chief: next, workers });
        this.sm.emit('failover', { from: chief, to: next, reason: err.type, message: err.message });
        this.sm.log(`Şeflik devredildi: ${chief} → ${next} (${err.type})`, 'warn');
      }
    }
  }

  #pickFallbackChief(tried) {
    const fb = this.config.fallbackChief;
    if (fb && !tried.has(fb) && this.isAvailable(fb)) return fb;
    return this.sm.workers.find((w) => !tried.has(w) && this.isAvailable(w)) || null;
  }

  async #chiefJson(prompt, schema, { shape, signal, mode } = {}) {
    const text = await this.callChief(prompt, { signal, mode });
    try {
      return parseWith(schema, text);
    } catch (err) {
      this.sm.log(`Şef çıktısı ayrıştırılamadı, onarım isteniyor: ${err.message}`, 'warn');
      const fixed = await this.callChief(P.repairJson({ badOutput: text, error: err.message, shape }), { signal, mode });
      return parseWith(schema, fixed);
    }
  }

  // ---------------------------------------------------------------- phase 1

  async #runPlanning({ previousPlan, feedback }) {
    const sid = this.sm.sessionId;
    const { signal } = this.controller;
    const request = this.sm.prompt;
    const tree = await this.workspace.tree();
    const transcript = [];
    this.session = { request, tree, transcript };
    const opts = { signal, mode: 'PLANNING' };
    const rounds = Math.max(1, this.config.debateRounds);

    let draft = await this.callChief(P.chiefDraft({ request, tree, previousPlan, feedback }), opts);
    this.#guard(sid, signal);
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
        draft = await this.callChief(P.chiefRevise({ request, tree, draft, transcript, round }), opts);
        this.#guard(sid, signal);
        transcript.push({ agent: this.sm.chief, label: this.adapters[this.sm.chief].label, role: 'chief', round: round + 1, text: draft });
      }
    }

    const plan = await this.#chiefJson(P.chiefSynthesize({ request, tree, draft, transcript }), ArchPlanSchema, {
      shape: P.SHAPES.ARCH_PLAN,
      ...opts,
    });
    this.#guard(sid, signal);
    this.sm.transition('planReady', { plan });
  }

  // ---------------------------------------------------------------- phase 2

  async #runCoding() {
    const sid = this.sm.sessionId;
    const { signal } = this.controller;
    const opts = { signal, mode: 'CODING' };
    const request = this.sm.prompt;
    const plan = this.sm.plan;

    const sha = await this.workspace.snapshot(`pre-coding ${sid}`);
    this.sm.update({ snapshotSha: sha });
    this.sm.log(`Git snapshot alındı: ${sha.slice(0, 8)}`);

    const tree = this.session?.tree ?? (await this.workspace.tree());
    let workers = this.availableWorkers([this.sm.chief]);
    if (!workers.length) workers = [this.sm.chief];

    const { tasks: rawTasks } = await this.#chiefJson(P.chiefDecompose({ request, tree, plan, workers }), TaskListSchema, opts);
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
        const text = await this.callAgent(worker, prompt, { role: 'worker', mode, signal });
        this.#guard(sid, signal);
        const files = parseFileEnvelope(text);
        const match = files.find((f) => normalizeRel(f.path).toLowerCase() === task.file_path.toLowerCase()) || (files.length === 1 ? files[0] : null);
        if (!match) throw new AgentError(ErrorType.CRASH, `${worker} beklenen dosya zarfını üretmedi`, { agent: worker });
        if (normalizeRel(match.path) !== task.file_path) {
          this.sm.log(`${worker} farklı yol yazdı (${match.path}); görevdeki yol kullanılıyor: ${task.file_path}`, 'warn');
        }
        await this.workspace.writeFile(task.file_path, match.content);
        this.#setTask(i, { status: 'done', worker });
        this.sm.log(`✔ ${task.action} ${task.file_path} (${worker})`);
        return;
      } catch (err) {
        if (err.type === ErrorType.ABORTED || signal.aborted) throw err;
        this.sm.log(`✖ ${task.file_path} @ ${worker}: ${err.message}. Yedek işçiye aktarılıyor`, 'warn');
      }
    }
    this.#setTask(i, { status: 'failed' });
  }
}
