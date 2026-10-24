import React, { useEffect, useRef, useState } from 'react';
import { Box, useApp, useInput, useStdout } from 'ink';
import { Header } from './components/Header.jsx';
import { AgentPanel } from './components/AgentPanel.jsx';
import { LiveDebate } from './components/LiveDebate.jsx';
import { PlanView } from './components/PlanView.jsx';
import { CommandInput } from './components/CommandInput.jsx';
import { EFFORTS } from '../config/config.js';

const MAX_LINES = 500;
const FLUSH_MS = 50;
const VARIANTS = [null, 'low', 'medium', 'high', 'max'];

/**
 * Collects agent chunks into complete lines. Each agent keeps its own open line so
 * parallel workers never interleave mid-line; renders are batched every FLUSH_MS.
 */
function useDebateFeed(sm) {
  const lines = useRef([]);
  const open = useRef(new Map());
  const dirty = useRef(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    const push = (e) => {
      lines.current.push(e);
      if (lines.current.length > MAX_LINES) lines.current.splice(0, lines.current.length - MAX_LINES);
      dirty.current = true;
    };
    const flush = (agent) => {
      const cur = open.current.get(agent);
      if (cur?.text.trim()) push({ ...cur });
      open.current.delete(agent);
      dirty.current = true;
    };
    const onChunk = ({ agent, label, role, kind, text }) => {
      if (kind === 'start') {
        push({ agent: '_sys', level: 'info', text: `▶ ${label} (${role === 'chief' ? 'şef' : 'işçi'})` });
        return;
      }
      if (kind === 'end') return flush(agent);
      if (kind === 'error') {
        flush(agent);
        push({ agent, label, kind: 'error', text: text.trim() });
        return;
      }
      const k = kind === 'separator' ? 'text' : kind;
      let cur = open.current.get(agent);
      if (cur && cur.kind !== k) {
        flush(agent);
        cur = null;
      }
      if (!cur) {
        cur = { agent, label, kind: k, text: '' };
        open.current.set(agent, cur);
      }
      cur.text += text;
      const parts = cur.text.split('\n');
      cur.text = parts.pop();
      for (const p of parts) if (p.trim()) push({ agent, label, kind: k, text: p });
      dirty.current = true;
    };
    const onLog = ({ level, text }) => push({ agent: '_sys', level, text });

    sm.logHistory.forEach(onLog);
    sm.on('chunk', onChunk);
    sm.on('log', onLog);
    const iv = setInterval(() => {
      if (dirty.current) {
        dirty.current = false;
        setTick((t) => t + 1);
      }
    }, FLUSH_MS);
    return () => {
      sm.off('chunk', onChunk);
      sm.off('log', onLog);
      clearInterval(iv);
    };
  }, [sm]);

  const live = [...open.current.values()].filter((e) => e.text).map((e) => ({ ...e, open: true }));
  return [...lines.current, ...live];
}

function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ cols: stdout.columns || 100, rows: stdout.rows || 30 });
  useEffect(() => {
    const onResize = () => setSize({ cols: stdout.columns, rows: stdout.rows });
    stdout.on('resize', onResize);
    return () => stdout.off('resize', onResize);
  }, [stdout]);
  return size;
}

function cycle(list, current) {
  const i = list.indexOf(current ?? null);
  return list[(i + 1) % list.length];
}

export function App({ sm, orch, workspace, telegram, onQuit }) {
  const { exit } = useApp();
  const { cols, rows } = useTerminalSize();
  const [state, setState] = useState(sm.snapshot());
  const [tg, setTg] = useState(telegram?.status || 'off');
  const [mode, setMode] = useState('input');
  const [value, setValue] = useState('');
  const [message, setMessage] = useState(null);
  const [settings, setSettings] = useState(false);
  const [sel, setSel] = useState(0);
  const [scroll, setScroll] = useState(0);
  const entries = useDebateFeed(sm);

  useEffect(() => {
    const onState = (s) => setState(s);
    const onAgents = (agents) => setState((prev) => ({ ...prev, agents }));
    sm.on('state', onState);
    sm.on('agents', onAgents);
    telegram?.on('status', setTg);
    return () => {
      sm.off('state', onState);
      sm.off('agents', onAgents);
      telegram?.off('status', setTg);
    };
  }, [sm, telegram]);

  const order = [state.chief, ...state.workers, ...Object.keys(state.agents)].filter((id, i, a) => id && a.indexOf(id) === i);

  const flash = (res, okText) => {
    if (!res) return;
    setMessage(res.ok ? (okText ? { level: 'ok', text: okText } : null) : { level: 'warn', text: res.reason });
  };

  const quit = () => {
    onQuit?.();
    exit();
  };

  const rollback = async () => {
    const res = await orch.rollback('tui');
    flash(res, res.ok ? `↩ Geri alındı (${res.sha.slice(0, 8)})` : undefined);
  };

  const runSlash = (cmd) => {
    const [name, ...rest] = cmd.slice(1).split(/\s+/);
    const arg = rest.join(' ');
    switch (name) {
      case 'approve':
      case 'onay':
        return flash(orch.approve('tui'), '🚀 Kodlama başladı');
      case 'replan':
        return flash(orch.replan(arg, 'tui'), '🔄 Yeniden planlanıyor');
      case 'cancel':
      case 'iptal':
        return flash(orch.cancel('tui'), 'İptal edildi');
      case 'abort':
        return flash(orch.abort('tui'), '🛑 Durduruldu');
      case 'rollback':
        return void rollback();
      case 'accept':
        return flash(orch.accept('tui'), 'Değişiklikler kabul edildi');
      case 'chief':
        return flash(orch.setChief(arg), `Şef: ${arg}`);
      case 'quit':
      case 'exit':
        return quit();
      default:
        return setMessage({ level: 'warn', text: `Bilinmeyen komut: /${name}` });
    }
  };

  const onSubmit = (text) => {
    const t = text.trim();
    if (!t) return;
    if (t.startsWith('/')) {
      runSlash(t);
      setValue('');
      return;
    }
    const res = state.status === 'AWAITING_APPROVAL' ? orch.replan(t, 'tui') : orch.submit(t, 'tui');
    flash(res);
    if (res.ok) {
      setValue('');
      setScroll(0);
      setMode('command');
    }
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') return quit();
    if (key.tab) {
      setSettings((s) => !s);
      return;
    }
    if (settings) {
      const id = order[sel];
      const agent = state.agents[id] || {};
      if (key.escape) setSettings(false);
      else if (key.leftArrow) setSel((s) => (s - 1 + order.length) % order.length);
      else if (key.rightArrow) setSel((s) => (s + 1) % order.length);
      else if (input.toLowerCase() === 's') flash(orch.setChief(id), `★ Şef: ${agent.label || id}`);
      else if (input.toLowerCase() === 'm') {
        const model = cycle([null, ...(agent.models || [])], agent.model);
        flash(orch.updateAgent(id, { model }), `${agent.label}: model → ${model || 'varsayılan'}`);
      } else if (input.toLowerCase() === 'e') {
        if (id === 'opencode') {
          const variant = cycle(VARIANTS, agent.variant);
          flash(orch.updateAgent(id, { variant }), `${agent.label}: variant → ${variant || 'yok'}`);
        } else {
          const effort = cycle(EFFORTS, agent.effort);
          flash(orch.updateAgent(id, { effort }), `${agent.label}: effort → ${effort}`);
        }
      }
      return;
    }
    if (mode === 'input') {
      if (key.escape) setMode('command');
      return;
    }
    if (key.return || input === 'i' || input === 'I') return setMode('input');
    if (key.pageUp) return setScroll((s) => s + 10);
    if (key.upArrow) return setScroll((s) => s + 1);
    if (key.pageDown) return setScroll((s) => Math.max(0, s - 10));
    if (key.downArrow) return setScroll((s) => Math.max(0, s - 1));
    switch (input.toLowerCase()) {
      case 'c':
        return flash(orch.approve('tui'), '🚀 Kodlama başladı');
      case 'p':
        if (state.status === 'AWAITING_APPROVAL') return flash(orch.replan('', 'tui'), '🔄 Yeniden planlanıyor');
        return setMode('input');
      case 'x':
        return flash(orch.cancel('tui'), 'İptal edildi');
      case 'u':
        return void rollback();
      case 'a':
        return flash(orch.accept('tui'), 'Değişiklikler kabul edildi');
      case 'q':
        return quit();
      default:
    }
  });

  // ---- layout
  const perRow = Math.max(1, Math.floor(cols / 30));
  const agentH = Math.ceil(order.length / perRow) * 4 + (settings ? 1 : 0);
  const mainH = Math.max(6, rows - 1 - 3 - agentH - 4);
  const hasSide = Boolean(state.plan || state.diff || state.tasks?.length) && state.status !== 'IDLE' && state.status !== 'DEBATING';
  const sideBySide = hasSide && cols >= 110;
  const planW = sideBySide ? Math.min(64, Math.floor(cols * 0.4)) : cols;
  const planH = hasSide && !sideBySide ? Math.min(18, Math.floor(mainH * (state.status === 'AWAITING_APPROVAL' ? 0.6 : 0.45))) : mainH;
  const debateW = sideBySide ? cols - planW : cols;
  const debateH = hasSide && !sideBySide ? mainH - planH : mainH;

  const placeholder =
    state.status === 'AWAITING_APPROVAL' ? 'Geri bildirim yazıp Enter → yeniden planla (ya da Esc, C ile onayla)' : 'Ne inşa edelim? (/approve /replan /cancel /rollback /abort)';

  return (
    <Box flexDirection="column" width={cols} height={rows - 1}>
      <Header root={workspace.root} state={state} telegram={tg} width={cols} />
      <AgentPanel order={order} state={state} settings={settings} selected={sel} />
      <Box flexDirection={sideBySide ? 'row' : 'column'} height={mainH}>
        <LiveDebate entries={entries} height={debateH} width={debateW} scroll={scroll} />
        {hasSide && <PlanView state={state} width={planW} height={planH} />}
      </Box>
      <CommandInput
        mode={settings ? 'command' : mode}
        value={value}
        onChange={setValue}
        onSubmit={onSubmit}
        status={state.status}
        canRollback={Boolean(state.snapshotSha)}
        message={message}
        placeholder={placeholder}
      />
    </Box>
  );
}
