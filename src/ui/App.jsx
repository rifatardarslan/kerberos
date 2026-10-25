import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Static, useApp, useInput, useStdout } from 'ink';
import { TranscriptItem } from './components/LiveDebate.jsx';
import { LiveAgents } from './components/AgentPanel.jsx';
import { SelectMenu } from './components/SelectMenu.jsx';
import { QuestionPrompt } from './components/QuestionPrompt.jsx';
import { PromptInput, SlashMenu, FileMenu, Footer, Shortcuts } from './components/CommandInput.jsx';
import { COMMANDS, MODE_OPTIONS, findCommand, matchCommands } from './commands.js';
import { LOGIN_HINT, buildUsage, runDoctor } from './reports.js';
import { MODE_INFO, relTime } from './theme.js';
import { copyNotice, watchCopies } from './clipboard.js';
import { EFFORTS, saveUserSettings, userSettingsFile } from '../config/config.js';
import { describeEffort, describeModel } from '../core/models.js';
import { formatAnswers, parseTriage } from '../core/prompts.js';

const PRINT_STEPS = new Set(['draft', 'critique', 'revise', 'compact', 'triage', 'solve', 'answer', 'final']);
// The chief's triage reply starts with "KIND: …": shown as a reply, a solution or the draft.
const TRIAGE_STEP = { chat: 'reply', question: 'solve', task: 'draft' };
// Answers meant for the user are printed in full, not folded.
const FULL_STEPS = new Set(['reply', 'final']);
const VARIANTS = [null, 'low', 'medium', 'high', 'max'];
const MESSAGE_MS = 5000;
// Claude Code's empty prompt suggests something to try.
const EXAMPLES = ['Örn. "bu projede testler nasıl çalışıyor?"', 'Örn. "login sayfasına şifre sıfırlama ekle"', 'Örn. "@src/index.js ne yapıyor?"', 'Örn. "README\'yi güncelle"'];
const AT_QUERY = /(?:^|\s)@([^\s@]*)$/;

let nextId = 1;
const mk = (item) => ({ ...item, id: nextId++ });

function useColumns() {
  const { stdout } = useStdout();
  const [cols, setCols] = useState(stdout.columns || 100);
  useEffect(() => {
    const onResize = () => setCols(stdout.columns);
    stdout.on('resize', onResize);
    return () => stdout.off('resize', onResize);
  }, [stdout]);
  return cols;
}

/**
 * Claude Code / Codex style shell: finished output is printed once into the
 * terminal's own scrollback (<Static>), while the bottom of the screen holds the
 * live agents, an optional choice box, the prompt and a status line.
 */
export function App({ sm, orch, workspace, telegram, config, sessions, catalog, history, version, openResume = false, onQuit }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const cols = useColumns();

  const [state, setState] = useState(() => sm.snapshot());
  const [rc, setRc] = useState(telegram?.status || 'off');

  const label = (id) => sm.agents[id]?.label || id;
  const modelText = (id, agent = sm.agents[id]) => describeModel(id, agent, catalog);
  const effortText = (id, agent = sm.agents[id]) => describeEffort(id, agent, catalog);

  const bannerItem = useCallback(
    (session = sessions?.current, resumed = false) =>
      mk({
        type: 'banner',
        props: {
          version,
          root: workspace.root,
          state: sm.snapshot(),
          rc: telegram?.status || 'off',
          chiefModel: describeModel(sm.chief, sm.agents[sm.chief], catalog).replace(/^CLI varsayılanı · /, ''),
          session: session && { shortId: session.shortId, title: session.title, resumed },
          recent: (sessions?.list() || [])
            .filter((m) => m.id !== session?.id && m.turns?.length)
            .slice(0, 3)
            .map((m) => ({ id: m.id, title: m.title, updatedAt: m.updatedAt })),
        },
      }),
    [version, workspace, sm, telegram, sessions, catalog],
  );

  /** Banner, then (when resuming) the saved transcript. */
  const openingItems = useCallback(
    (session, resumed) => {
      const out = [bannerItem(session, resumed)];
      if (resumed && session) {
        out.push(...session.items().map(mk));
        out.push(mk({ type: 'resumed', text: `Oturum sürdürülüyor · ${session.turns.length} tur · son etkinlik ${relTime(session.meta.updatedAt)}` }));
      }
      return out;
    },
    [bannerItem],
  );

  const [items, setItems] = useState(() => [
    ...openingItems(sessions?.current, Boolean(sessions?.current?.persisted)),
    ...sm.logHistory.filter((l) => l.level !== 'debug').map((l) => mk({ type: 'info', level: l.level, text: l.text })),
  ]);
  const [staticKey, setStaticKey] = useState(0);
  const lastLong = useRef(null);

  const print = useCallback(
    (item) => {
      const m = mk(item);
      if (m.type === 'agent' && !m.full && m.text.split('\n').length > 10) lastLong.current = m;
      setItems((prev) => [...prev, m]);
      sessions?.current?.appendItem(m);
    },
    [sessions],
  );

  // ---- live agent calls (spinner rows)
  const live = useRef(new Map());
  const [frame, setFrame] = useState(0);
  const [now, setNow] = useState(Date.now());
  // For the spinner line: when the turn started and how much the agents have written.
  const turnStart = useRef(0);
  const streamed = useRef(0);
  const [example] = useState(() => EXAMPLES[Math.floor(Math.random() * EXAMPLES.length)]);

  // ---- input
  const [value, setValue] = useState('');
  const [inputMode, setInputMode] = useState(null); // null | { kind: 'feedback' } | { kind: 'model', agent }
  const [menuIdx, setMenuIdx] = useState(0);
  const [menuHidden, setMenuHidden] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [message, setMessage] = useState(null);
  const [ctrlC, setCtrlC] = useState(false);
  const [dialog, setDialog] = useState(openResume ? { kind: 'resume' } : null);
  const [queue, setQueue] = useState([]);
  const [files, setFiles] = useState(null);
  const histIdx = useRef(-1);
  const draft = useRef('');
  const prevTasks = useRef([]);

  const setInput = (v) => {
    setValue(v);
    setMenuHidden(false);
  };

  const flash = useCallback((res, okText) => {
    if (!res || res.noop) return;
    if (!res.ok) setMessage({ level: 'warn', text: res.reason });
    else if (okText) setMessage({ level: 'ok', text: okText });
  }, []);

  useEffect(() => {
    if (!message) return undefined;
    const t = setTimeout(() => setMessage(null), MESSAGE_MS);
    return () => clearTimeout(t);
  }, [message]);

  // ---- "N karakter kopyalandı" when text selected in the terminal lands on the clipboard
  useEffect(() => watchCopies((copy) => setMessage({ level: 'ok', text: copyNotice(copy) })), []);

  // ---- spinner clock (only ticks while something is running)
  useEffect(() => {
    const iv = setInterval(() => {
      if (live.current.size || sm.busy) {
        setFrame((f) => f + 1);
        setNow(Date.now());
      }
    }, 100);
    return () => clearInterval(iv);
  }, [sm]);

  // ---- session switches (/new, /resume): reprint the screen for the other conversation
  useEffect(() => {
    if (!sessions) return undefined;
    const onSession = (session, { resumed }) => {
      stdout.write('\x1b[2J\x1b[3J\x1b[H');
      live.current.clear();
      prevTasks.current = [];
      lastLong.current = null;
      setDialog(null);
      setInputMode(null);
      setQueue([]);
      setState(sm.snapshot());
      setItems(openingItems(session, resumed));
      setStaticKey((k) => k + 1);
    };
    sessions.on('session', onSession);
    return () => sessions.off('session', onSession);
  }, [sessions, sm, stdout, openingItems]);

  // ---- state machine -> transcript
  useEffect(() => {
    const via = (meta) => (meta.source === 'telegram' ? '📱 Telegram' : meta.source === 'auto' ? 'otomatik mod' : undefined);

    const onChunk = (c) => {
      const key = `${c.agent}:${c.meta?.file || c.step || ''}`;
      const m = live.current;
      if (c.kind === 'start') {
        m.set(key, { agent: c.agent, label: c.label, role: c.role, step: c.step, meta: c.meta, text: '', thinking: false, startedAt: Date.now(), seed: Math.floor(Math.random() * 97) });
        return;
      }
      const e = m.get(key);
      if (c.kind === 'end') {
        m.delete(key);
        if (!c.step || PRINT_STEPS.has(c.step)) {
          let step = c.step;
          let text = (c.final || e?.text || '').trim();
          if (step === 'triage') {
            const t = parseTriage(text);
            step = TRIAGE_STEP[t.kind];
            text = t.text;
          }
          print({ type: 'agent', agent: c.agent, label: c.label, role: c.role, step, durationMs: c.durationMs, usage: c.usage, text, full: FULL_STEPS.has(step) });
        }
        return;
      }
      if (c.kind === 'error') {
        m.delete(key);
        const hint = /AUTH/.test(c.text) && LOGIN_HINT[c.agent] ? ` · giriş için: ${LOGIN_HINT[c.agent]}` : '';
        print({ type: 'info', level: 'error', text: `${c.label}: ${c.text.trim()}${hint}` });
        return;
      }
      if (!e) return;
      if (c.kind === 'thinking') {
        e.thinking = true;
        return;
      }
      if (c.kind === 'tool' || c.kind === 'system') return;
      e.thinking = false;
      e.text += c.text;
      streamed.current += c.text.length;
      if (e.text.length > 4000) e.text = e.text.slice(-2000);
    };

    const onState = (snap, meta) => {
      setState(snap);
      switch (meta.action) {
        case 'submit':
          prevTasks.current = [];
          turnStart.current = Date.now();
          streamed.current = 0;
          print({ type: 'user', text: snap.prompt, source: meta.source });
          break;
        case 'replan':
          turnStart.current = Date.now();
          streamed.current = 0;
          if (snap.feedback) print({ type: 'user', text: snap.feedback, source: meta.source });
          print({ type: 'phase', color: 'magenta', text: 'Yeniden planlanıyor', detail: via(meta) });
          break;
        case 'clarify':
          print({ type: 'phase', color: 'yellow', text: `Şefin ${snap.questions.length} sorusu var`, detail: 'yanıtlarınıza göre planlanacak' });
          setDialog({ kind: 'questions' });
          break;
        case 'answered':
          turnStart.current = Date.now();
          streamed.current = 0;
          print({ type: 'user', text: formatAnswers(snap.questions, snap.answers), source: meta.source });
          break;
        case 'planReady': {
          print({ type: 'plan', plan: snap.plan });
          const actionable = snap.plan?.files_to_modify?.length && !snap.plan?.questions?.length;
          if (snap.permissionMode === 'plan') {
            print({ type: 'info', level: 'info', text: 'Yalnızca plan modu: uygulamak için /approve, değiştirmek için yazın' });
          } else if (!(snap.permissionMode === 'auto' && actionable)) {
            setDialog({ kind: 'approve' });
          }
          break;
        }
        case 'approve':
          turnStart.current = Date.now();
          streamed.current = 0;
          print({ type: 'phase', color: 'green', text: 'Kodlama başlıyor', detail: via(meta) || 'önce snapshot alınıyor' });
          break;
        case 'noop':
          print({ type: 'info', level: 'ok', text: 'Uygulanacak değişiklik yok, tur kapatıldı' });
          break;
        case 'cancel':
          print({ type: 'info', level: 'warn', text: `Plan iptal edildi${via(meta) ? ` · ${via(meta)}` : ''}` });
          break;
        case 'buildDone':
          setFiles(null);
          print({ type: 'diff', diff: snap.diff, tasks: snap.tasks, error: snap.error });
          break;
        case 'abort':
          live.current.clear();
          setQueue([]);
          print({ type: 'error', text: `Durduruldu${via(meta) ? ` · ${via(meta)}` : ''}` });
          break;
        case 'fail':
          live.current.clear();
          setQueue([]);
          print({ type: 'error', text: snap.error || 'Bilinmeyen hata' });
          break;
        case 'rollback':
          setFiles(null);
          print({ type: 'success', text: 'Değişiklikler geri alındı', detail: `dosyalar snapshot’a döndü${via(meta) ? ` · ${via(meta)}` : ''}` });
          break;
        case 'update': {
          const prev = prevTasks.current;
          const cur = snap.tasks || [];
          if (cur.length && !prev.length) {
            print({ type: 'phase', text: `${cur.length} göreve bölündü`, detail: cur.map((t) => t.file_path).join(', ') });
          }
          cur.forEach((t, i) => {
            if ((t.status === 'done' || t.status === 'failed') && prev[i]?.status !== t.status) print({ type: 'task', task: { ...t, workerLabel: label(t.worker) } });
          });
          prevTasks.current = cur;
          break;
        }
        default:
      }
    };

    const onAgents = (agents) => setState((prev) => ({ ...prev, agents }));
    const onLog = ({ level, text }) => level !== 'debug' && print({ type: 'info', level, text });
    const onFailover = ({ from, to, reason }) => print({ type: 'phase', color: 'yellow', text: `Şeflik devredildi: ${label(from)} → ${label(to)}`, detail: reason });

    sm.on('chunk', onChunk);
    sm.on('state', onState);
    sm.on('agents', onAgents);
    sm.on('log', onLog);
    sm.on('failover', onFailover);
    telegram?.on('status', setRc);
    return () => {
      sm.off('chunk', onChunk);
      sm.off('state', onState);
      sm.off('agents', onAgents);
      sm.off('log', onLog);
      sm.off('failover', onFailover);
      telegram?.off('status', setRc);
    };
  }, [sm, telegram, print]);

  // Close choice boxes that no longer apply (e.g. approved from Telegram).
  useEffect(() => {
    if (dialog?.kind === 'approve' && state.status !== 'AWAITING_APPROVAL') setDialog(null);
    if (dialog?.kind === 'questions' && state.status !== 'AWAITING_ANSWERS') setDialog(null);
    if (inputMode?.kind === 'answer' && state.status !== 'AWAITING_ANSWERS') setInputMode(null);
    if (inputMode?.kind === 'feedback' && state.status !== 'AWAITING_APPROVAL') setInputMode(null);
  }, [state.status, dialog, inputMode]);

  // Messages typed while agents were busy go out once the round is over.
  useEffect(() => {
    if (!queue.length || !['IDLE', 'DONE'].includes(state.status)) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    flash(orch.submit(next, 'tui'));
  }, [state.status, queue, orch, flash]);

  // ---- settings that persist across runs (like Claude Code's /model)
  const persist = (patch) => {
    try {
      saveUserSettings(patch);
    } catch (err) {
      setMessage({ level: 'warn', text: `Ayar kaydedilemedi: ${err.message}` });
    }
  };
  const setChief = (id) => {
    const res = orch.setChief(id);
    if (res.ok) persist({ chief: id });
    flash(res, `★ Şef artık ${label(id)}`);
  };
  const setMode = (m) => {
    const res = orch.setPermissionMode(m);
    if (res.ok) persist({ permissionMode: m });
    flash(res, `Mod: ${MODE_INFO[m]?.label} · ${MODE_INFO[m]?.hint}`);
  };
  const setAgentOpt = (id, patch, text) => {
    const res = orch.updateAgent(id, patch);
    if (res.ok) persist({ agents: { [id]: patch } });
    flash(res, text);
  };

  // ---- commands
  const quit = () => {
    onQuit?.();
    exit();
  };

  const clear = ({ banner }) => {
    stdout.write('\x1b[2J\x1b[3J\x1b[H');
    setItems(banner ? [bannerItem()] : []);
    setStaticKey((k) => k + 1);
  };

  const ctx = {
    orch,
    sm,
    telegram,
    workspace,
    config,
    sessions,
    catalog,
    flash,
    clear,
    quit,
    label,
    setChief,
    setMode,
    openDialog: setDialog,
    submit: (t, opts) => flash(orch.submit(t, 'tui', opts)),
    usage: async () => {
      setMessage({ level: 'info', text: 'Kullanım bilgisi alınıyor…' });
      print(await buildUsage({ sm, session: sessions?.current, catalog }));
      setMessage(null);
    },
    doctor: async () => {
      setMessage({ level: 'info', text: 'Kontrol ediliyor…' });
      print(await runDoctor({ sm, orch, telegram, workspace, settingsFile: userSettingsFile() }));
      setMessage(null);
    },
    print: (item) => {
      if (item.type !== 'status') return print(item);
      const models = Object.fromEntries(Object.keys(sm.agents).map((id) => [id, { model: modelText(id), effort: effortText(id) }]));
      const cur = sessions?.current;
      print({
        ...item,
        snapshot: sm.snapshot(),
        rc: telegram?.status || 'off',
        root: workspace.root,
        sources: config.sources,
        settingsFile: userSettingsFile(),
        models,
        session: { shortId: cur?.shortId || '—', title: cur?.title, turns: cur?.turns.length || 0 },
      });
    },
  };

  const runCommand = (cmd, arg = '') =>
    Promise.resolve()
      .then(() => cmd.run(ctx, arg.trim()))
      .catch((err) => print({ type: 'error', text: `/${cmd.name}: ${err.message}` }));

  // ---- suggestion menus (/commands, @files)
  const slashQuery = value.startsWith('/') && !/\s/.test(value) ? value.slice(1) : null;
  const atMatch = slashQuery === null ? AT_QUERY.exec(value) : null;
  const atQuery = atMatch ? atMatch[1] : null;
  useEffect(() => {
    if (atQuery !== null && files === null) workspace.listFiles().then(setFiles, () => setFiles([]));
  }, [atQuery, files, workspace]);

  let menu = null;
  if (!menuHidden && slashQuery !== null) menu = { kind: 'slash', items: matchCommands(slashQuery) };
  else if (!menuHidden && atQuery !== null && files) {
    const q = atQuery.toLowerCase();
    const hits = files.filter((f) => f.toLowerCase().includes(q));
    hits.sort((a, b) => Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q)) || a.length - b.length);
    menu = { kind: 'file', items: hits.slice(0, 50) };
  }
  const menuKey = menu ? `${menu.kind}:${slashQuery ?? atQuery}` : '';
  useEffect(() => setMenuIdx(0), [menuKey]);
  const menuOpen = Boolean(menu?.items.length);

  const completeFile = (f) => setInput(`${value.slice(0, value.length - atQuery.length)}${f} `);

  const onChange = (v) => {
    if (v === '?' && value === '') {
      setShowKeys((s) => !s);
      return;
    }
    setShowKeys(false);
    histIdx.current = -1;
    setValue(v);
    setMenuHidden(false);
  };

  // ↑/↓ walk the history; below the newest entry comes back whatever was being typed
  // (usually nothing). A recalled "/command" must not open the menu, or the menu
  // would take the arrow keys and ↓ could never get back down.
  const recall = (v) => {
    setValue(v);
    setMenuHidden(true);
  };
  const onEdge = (dir) => {
    const h = history?.list || [];
    if (dir === 'up') {
      if (!h.length) return;
      if (histIdx.current < 0) draft.current = value;
      histIdx.current = histIdx.current < 0 ? h.length - 1 : Math.max(0, histIdx.current - 1);
      recall(h[histIdx.current]);
      return;
    }
    if (histIdx.current < 0) return;
    histIdx.current += 1;
    if (histIdx.current >= h.length) {
      histIdx.current = -1;
      recall(draft.current);
      draft.current = '';
      return;
    }
    recall(h[histIdx.current]);
  };

  const onSubmit = (raw) => {
    // Enter on an open menu picks the highlighted entry.
    if (menuOpen && menu.kind === 'slash') {
      const exact = findCommand(slashQuery);
      const cmd = exact || menu.items[menuIdx];
      if (cmd.args?.startsWith('<') && !exact) {
        setInput(`/${cmd.name} `);
        return;
      }
      setInput('');
      history?.add(`/${cmd.name}`);
      runCommand(cmd);
      return;
    }
    if (menuOpen && menu.kind === 'file') {
      completeFile(menu.items[menuIdx]);
      return;
    }

    const t = raw.trim();
    if (!t) return;
    history?.add(t);
    histIdx.current = -1;
    setInput('');

    if (t.startsWith('/') && !t.includes('\n')) {
      const [name, ...rest] = t.slice(1).split(/\s+/);
      const cmd = findCommand(name);
      if (!cmd) {
        setMessage({ level: 'warn', text: `Bilinmeyen komut: /${name} (/help)` });
        return;
      }
      runCommand(cmd, rest.join(' '));
      return;
    }
    if (inputMode?.kind === 'model') {
      setInputMode(null);
      setAgentOpt(inputMode.agent, { model: t }, `${label(inputMode.agent)}: model → ${t}`);
      return;
    }
    if (inputMode?.kind === 'answer' || state.status === 'AWAITING_ANSWERS') {
      setInputMode(null);
      const res = orch.answerQuestion(orch.openQuestion, t, 'tui');
      flash(res);
      if (res.ok && !res.done) setDialog({ kind: 'questions' });
      return;
    }
    if (inputMode?.kind === 'feedback' || state.status === 'AWAITING_APPROVAL') {
      setInputMode(null);
      flash(orch.replan(t, 'tui'));
      return;
    }
    if (sm.busy) {
      setQueue((q) => [...q, t]);
      setMessage({ level: 'info', text: 'Kuyruğa alındı: tur bitince gönderilecek' });
      return;
    }
    flash(orch.submit(t, 'tui'));
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (value) return setInput('');
      if (ctrlC) return quit();
      setCtrlC(true);
      setTimeout(() => setCtrlC(false), 2000);
      return undefined;
    }
    if (dialog) return undefined; // the choice box owns the keyboard

    // Like Claude Code: shift+tab only flips the footer indicator, for this session;
    // no message, nothing saved (/mode and /config change the saved default).
    if (key.tab && key.shift) {
      const i = MODE_OPTIONS.findIndex((m) => m.id === sm.permissionMode);
      return orch.setPermissionMode(MODE_OPTIONS[(i + 1) % MODE_OPTIONS.length].id);
    }
    if (key.ctrl && input === 'o') {
      if (!lastLong.current) return setMessage({ level: 'info', text: 'Kısaltılmış çıktı yok' });
      return print({ ...lastLong.current, full: true });
    }
    if (key.ctrl && input === 'r') return setDialog({ kind: 'history', query: value });

    if (key.escape) {
      if (showKeys) return setShowKeys(false);
      if (menuOpen && menu.kind === 'slash') return setInput('');
      if (menuOpen) return setMenuHidden(true);
      if (sm.busy) return flash(orch.abort('tui'));
      if (inputMode) return setInputMode(null);
      if (value) return setInput('');
      if (state.status === 'AWAITING_APPROVAL' && state.permissionMode !== 'plan') return setDialog({ kind: 'approve' });
      if (state.status === 'AWAITING_ANSWERS') return setDialog({ kind: 'questions' });
      return undefined;
    }
    if (menuOpen) {
      const n = menu.items.length;
      if (key.upArrow) return setMenuIdx((i) => (i - 1 + n) % n);
      if (key.downArrow) return setMenuIdx((i) => (i + 1) % n);
      if (key.tab) {
        if (menu.kind === 'file') return completeFile(menu.items[menuIdx]);
        const c = menu.items[menuIdx];
        return setInput(`/${c.name}${c.args ? ' ' : ''}`);
      }
    }
    return undefined;
  });

  // ---- choice boxes
  const agentIds = [state.chief, ...state.workers, ...Object.keys(state.agents)].filter((id, i, a) => id && a.indexOf(id) === i);
  const agentHint = (id) => {
    const a = state.agents[id] || {};
    return [id === state.chief ? '★ şef' : 'işçi', modelText(id, a), a.status === 'unavailable' ? 'bulunamadı' : null].filter(Boolean).join(' · ');
  };

  function dialogSpec(d) {
    const close = () => setDialog(null);
    switch (d.kind) {
      case 'approve': {
        const plan = state.plan || {};
        const empty = !plan.files_to_modify?.length;
        const feedback = () => {
          close();
          setInputMode({ kind: 'feedback' });
        };
        return {
          title: empty ? 'Plan dosya değişikliği içermiyor' : 'Plan hazır. Kodlamaya geçilsin mi?',
          subtitle: empty
            ? plan.questions?.length
              ? 'Şefin soruları var. Yanıtlarsanız plan yeniden hazırlanır.'
              : undefined
            : `${plan.files_to_modify.length} dosya · önce snapshot alınır, /undo ile geri alınabilir`,
          options: empty
            ? [
                { label: plan.questions?.length ? 'Soruları yanıtla' : 'Geri bildirim yaz', action: feedback },
                { label: 'Tamam, turu kapat', action: () => (close(), flash(orch.approve('tui'))) },
                { label: 'İptal', action: () => (close(), flash(orch.cancel('tui'))) },
              ]
            : [
                { label: 'Evet, kodla', action: () => (close(), flash(orch.approve('tui'))) },
                { label: 'Evet, bundan sonra sormadan kodla', hint: 'otomatik mod', action: () => (close(), setMode('auto'), flash(orch.approve('tui'))) },
                { label: 'Hayır, geri bildirim yaz', action: feedback },
                { label: 'İptal', action: () => (close(), flash(orch.cancel('tui'))) },
              ],
        };
      }
      case 'agents':
        return {
          title: 'Ajanlar',
          options: agentIds.map((id) => ({ label: label(id), hint: agentHint(id), action: () => setDialog({ kind: 'agentActions', agent: id }) })),
        };
      case 'agentActions': {
        const id = d.agent;
        return {
          title: label(id),
          subtitle: agentHint(id),
          options: [
            { label: 'Şef yap', disabled: id === state.chief, action: () => (close(), setChief(id)) },
            { label: 'Model değiştir', hint: modelText(id), action: () => setDialog({ kind: 'model', agent: id }) },
            { label: id === 'opencode' ? 'Variant değiştir' : 'Effort değiştir', hint: effortText(id), action: () => setDialog({ kind: 'effort', agent: id }) },
            { label: 'Geri', action: () => setDialog({ kind: 'agents' }) },
          ],
        };
      }
      case 'pickAgent':
        return {
          title: d.next === 'chief' ? 'Yeni şef' : d.next === 'model' ? 'Hangi ajanın modeli?' : 'Hangi ajanın effort’u?',
          options: agentIds.map((id) => ({
            label: label(id),
            hint: d.next === 'effort' ? effortText(id) : agentHint(id),
            current: d.next === 'chief' && id === state.chief,
            action: () => (d.next === 'chief' ? (close(), setChief(id)) : setDialog({ kind: d.next, agent: id })),
          })),
        };
      case 'model': {
        const id = d.agent;
        const a = state.agents[id];
        if (!a) return { title: `Ajan yok: ${id}`, options: [{ label: 'Kapat', action: close }] };
        const set = (model) => (close(), setAgentOpt(id, { model }, `${label(id)}: model → ${model || 'CLI varsayılanı'}`));
        const listed = catalog?.list(id) || [];
        const extra = (a.models || []).filter((m) => !listed.some((x) => x.id === m)).map((m) => ({ id: m }));
        return {
          title: `${label(id)} modeli`,
          subtitle: `Şu an: ${modelText(id, a)} · seçim kaydedilir`,
          options: [
            { label: 'CLI varsayılanı', hint: modelText(id, { ...a, model: null }).replace(/^CLI varsayılanı ?·? ?/, ''), current: !a.model, action: () => set(null) },
            ...[...listed, ...extra].map((m) => ({ label: m.id, hint: m.name, current: a.model === m.id, action: () => set(m.id) })),
            { label: 'Özel model adı yaz…', action: () => (close(), setInputMode({ kind: 'model', agent: id })) },
          ],
        };
      }
      case 'effort': {
        const id = d.agent;
        const a = state.agents[id];
        if (!a) return { title: `Ajan yok: ${id}`, options: [{ label: 'Kapat', action: close }] };
        const variant = id === 'opencode';
        const field = variant ? 'variant' : 'effort';
        const cur = a[field] ?? null;
        const modelId = a.model || catalog?.defaults?.[id]?.model;
        const fromCatalog = catalog?.list(id).find((m) => m.id === modelId)?.efforts;
        const list = variant ? VARIANTS : [null, ...(fromCatalog?.length ? fromCatalog : EFFORTS)];
        return {
          title: `${label(id)} ${field}`,
          subtitle: `Şu an: ${effortText(id, a)}`,
          options: list.map((v) => ({
            label: v ?? 'CLI varsayılanı',
            hint: v === null ? effortText(id, { ...a, [field]: null }).replace(/^CLI varsayılanı ?·? ?/, '') : undefined,
            current: cur === v,
            action: () => (close(), setAgentOpt(id, { [field]: v }, `${label(id)}: ${field} → ${v ?? 'CLI varsayılanı'}`)),
          })),
        };
      }
      case 'mode':
        return {
          title: 'İzin modu',
          subtitle: 'shift+tab ile de değişir · seçim kaydedilir',
          options: MODE_OPTIONS.map((m) => ({ label: m.label, hint: m.hint, current: state.permissionMode === m.id, action: () => (close(), setMode(m.id)) })),
        };
      case 'resume': {
        const list = sessions?.list() || [];
        if (!list.length) return { title: 'Bu dizinde kayıtlı oturum yok', options: [{ label: 'Kapat', action: close }] };
        return {
          title: 'Oturuma devam et',
          subtitle: workspace.root,
          maxVisible: 12,
          options: list.map((m) => ({
            label: m.title || '(başlıksız)',
            hint: [m.id.slice(0, 8), relTime(m.updatedAt), `${m.turns?.length || 0} tur`, m.rc ? 'RC' : null].filter(Boolean).join(' · '),
            current: m.id === sessions.current?.id,
            action: () => (close(), sessions.resume(m.id).then((r) => flash(r, r.same ? 'Zaten bu oturumdasınız' : null))),
          })),
        };
      }
      case 'history': {
        const hits = history?.search(d.query || '') || [];
        if (!hits.length) return { title: `Geçmişte bulunamadı: ${d.query}`, options: [{ label: 'Kapat', action: close }] };
        return {
          title: d.query ? `Geçmiş: “${d.query}”` : 'Geçmiş',
          maxVisible: 12,
          options: hits.map((h) => ({ label: h.replace(/\s+/g, ' ').slice(0, 90), action: () => (close(), setInput(h)) })),
        };
      }
      case 'config': {
        const auto = Boolean(config.telegram?.autoStart);
        return {
          title: 'Ayarlar',
          subtitle: userSettingsFile(),
          options: [
            { label: 'İzin modu', hint: MODE_INFO[state.permissionMode]?.label, action: () => setDialog({ kind: 'mode' }) },
            {
              label: 'RC her açılışta başlasın',
              hint: auto ? 'açık' : 'kapalı',
              action: () => {
                config.telegram.autoStart = !auto;
                persist({ telegram: { autoStart: !auto } });
                setDialog({ kind: 'config', v: Date.now() });
              },
            },
            {
              label: 'Şef önce değerlendirsin',
              hint: config.triage !== false ? 'açık · sohbeti şef yanıtlar, soruyu herkes çözer' : 'kapalı · her mesaj plana gider',
              action: () => {
                config.triage = config.triage === false;
                persist({ triage: config.triage });
                setDialog({ kind: 'config', v: Date.now() });
              },
            },
            { label: 'Tartışma turu', hint: String(config.debateRounds), action: () => setDialog({ kind: 'rounds' }) },
            { label: 'Kapat', action: close },
          ],
        };
      }
      case 'rounds':
        return {
          title: 'Tartışma turu',
          subtitle: 'İşçilerin şef taslağını kaç tur eleştireceği',
          options: [1, 2, 3].map((n) => ({
            label: String(n),
            current: config.debateRounds === n,
            action: () => {
              config.debateRounds = n;
              persist({ debateRounds: n });
              setDialog({ kind: 'config' });
            },
          })),
        };
      default:
        return null;
    }
  }

  const spec = dialog ? dialogSpec(dialog) : null;
  const busy = state.status === 'DEBATING' || state.status === 'BUILDING';
  const placeholder =
    inputMode?.kind === 'feedback'
      ? 'Geri bildirim… (plan buna göre yeniden hazırlanır)'
      : inputMode?.kind === 'answer' || state.status === 'AWAITING_ANSWERS'
        ? 'Yanıtınızı yazın · esc seçenekler · /cancel iptal'
      : inputMode?.kind === 'model'
        ? `${label(inputMode.agent)} için model adı`
        : state.status === 'AWAITING_APPROVAL'
          ? state.permissionMode === 'plan'
            ? 'Planı değiştirmek için yazın · /approve uygular'
            : 'Geri bildirim yazın · esc seçenekler'
          : busy
            ? 'Yazmaya devam edin, tur bitince gönderilir'
            : example;

  return (
    <Box flexDirection="column">
      <Static key={staticKey} items={items}>
        {(item) => (
          <Box key={item.id} flexDirection="column" width={cols}>
            <TranscriptItem item={item} width={cols} />
          </Box>
        )}
      </Static>

      <LiveAgents live={live.current} frame={frame} now={now} status={state.status} busy={busy} width={cols} turnStart={turnStart.current} streamed={streamed.current} />

      {dialog?.kind === 'questions' && state.questions && orch.openQuestion >= 0 ? (
        <QuestionPrompt
          key={`${state.turnId}:${orch.openQuestion}`}
          questions={state.questions}
          answers={state.answers}
          index={orch.openQuestion}
          width={cols}
          onAnswer={(a) => flash(orch.answerQuestion(orch.openQuestion, a, 'tui'))}
          onOther={() => (setDialog(null), setInputMode({ kind: 'answer' }))}
          onHide={() => setDialog(null)}
        />
      ) : spec ? (
        <SelectMenu key={JSON.stringify(dialog)} {...spec} onSelect={(o) => o.action()} onCancel={() => setDialog(null)} />
      ) : (
        <>
          <PromptInput
            value={value}
            onChange={onChange}
            onSubmit={onSubmit}
            onEdge={onEdge}
            placeholder={placeholder}
            focus={!dialog}
            arrowsToParent={menuOpen}
            accent={inputMode ? 'magenta' : undefined}
            width={cols}
          />
          {menu?.kind === 'slash' && <SlashMenu items={menu.items} selected={menuIdx} />}
          {menu?.kind === 'file' && <FileMenu files={menu.items} selected={menuIdx} />}
        </>
      )}

      {showKeys ? (
        <Shortcuts />
      ) : (
        <Footer state={state} rc={rc} message={message} ctrlCArmed={ctrlC} inputMode={inputMode?.kind} queued={queue.length} width={cols} />
      )}
    </Box>
  );
}

export { COMMANDS };
