import React from 'react';
import { Box, Text } from 'ink';
import { BRAND, BULLET, MODE_INFO, STATUS_COLORS, STATUS_LABELS, STEP_LABELS, agentColor, bar, fmtCost, fmtTokens, localized, relTime, resetsIn, usageColor } from '../theme.js';
import { t, tn } from '../../i18n/index.js';
import { COMMANDS } from '../commands.js';
import { Banner } from './Header.jsx';
import { PlanCard, DiffCard, DiffText, Findings, PreviewCard, TaskLine } from './PlanView.jsx';
import { Bullet, Para, RichText, Tree } from './Blocks.jsx';

const ROLE = localized({ chief: 'chief', worker: 'worker' });
const PREVIEW_LINES = 4; // intermediate outputs are folded like Claude Code's tool results
// Replies meant for the user: printed like Claude's own answer ("● text"), never folded.
export const ANSWER_STEPS = new Set(['reply', 'final']);

const AGENT_STATE = localized({ idle: 'ready', busy: 'working', cooldown: 'cooling down', unavailable: 'unavailable' });

function secs(ms) {
  return ms == null ? '' : ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

/**
 * An answer for the user reads like Claude's own reply; every other agent output
 * looks like a tool call, folded to a few lines (ctrl+o reprints the last one whole).
 */
function AgentMessage({ item, width }) {
  if (ANSWER_STEPS.has(item.step)) {
    return (
      <Bullet>
        <RichText text={item.text} width={width - Bullet.indent} />
      </Bullet>
    );
  }
  const lines = item.text.split('\n');
  const cut = !item.full && lines.length > PREVIEW_LINES + 1;
  const text = cut ? lines.slice(0, PREVIEW_LINES).join('\n') : item.text;
  const tok = item.usage ? (item.usage.input || 0) + (item.usage.output || 0) : 0;
  const what = (item.step && STEP_LABELS[item.step]) || ROLE[item.role] || item.role;
  return (
    <Box flexDirection="column">
      <Bullet color="green">
        <Text wrap="truncate-end">
          <Text bold color={agentColor(item.agent)}>
            {item.label}
          </Text>
          <Text>({what})</Text>
          <Text color="gray">
            {item.durationMs ? ` · ${secs(item.durationMs)}` : ''}
            {tok ? ` · ${fmtTokens(tok)} token` : ''}
          </Text>
        </Text>
      </Bullet>
      <Tree>
        {item.text.trim() ? <RichText text={text} width={width - Tree.indent} /> : <Text color="gray">{t('(empty reply)')}</Text>}
        {cut && <Text color="gray">{`… ${tn(lines.length - PREVIEW_LINES, '+{n} line', '+{n} lines')} (${t('ctrl+o to expand')})`}</Text>}
      </Tree>
    </Box>
  );
}

const LEVEL_COLOR = { info: 'gray', warn: 'yellow', error: 'red', ok: 'green' };

function Title({ children }) {
  return (
    <Text>
      <Text color={BRAND}>{BULLET} </Text>
      <Text bold>{children}</Text>
    </Text>
  );
}

function KV({ k, children, pad = 11 }) {
  return (
    <Text wrap="truncate-end">
      {'  '}
      <Text color="gray">{k.padEnd(pad)}</Text>
      {children}
    </Text>
  );
}

const HELP_KEYS = localized([
  ['/', 'command menu (↑↓ pick, tab completes)'],
  ['@', 'attach a file: its content goes to the agents'],
  ['shift+tab', 'mode: ask → auto → plan only'],
  ['ctrl+r', 'search earlier prompts'],
  ['ctrl+o', 'show the last folded output in full'],
  ['\\ + enter', 'new line'],
]);

function Help() {
  const pad = Math.max(...COMMANDS.map((c) => (c.name + (c.args ? ` ${c.args}` : '')).length)) + 2;
  return (
    <Box flexDirection="column" marginY={1}>
      <Title>{t('Commands')}</Title>
      {COMMANDS.map((c) => (
        <Text key={c.name} wrap="truncate-end">
          {'  '}
          <Text color={BRAND}>/{(c.name + (c.args ? ` ${c.args}` : '')).padEnd(pad)}</Text>
          <Text color="gray">{c.desc}</Text>
          {c.aliases ? <Text color="gray"> ({c.aliases.map((a) => `/${a}`).join(', ')})</Text> : null}
        </Text>
      ))}
      <Text> </Text>
      <Text bold>{'  '}{t('Shortcuts')}</Text>
      {HELP_KEYS.map(([k, d]) => (
        <Text key={k}>
          {'  '}
          <Text color={BRAND}>{k.padEnd(pad + 1)}</Text>
          <Text color="gray">{d}</Text>
        </Text>
      ))}
      <Text> </Text>
      <Text color="gray" wrap="wrap">
        {'  '}
        {t('Plain text starts a task; the agents remember earlier turns of the session. What you type while they work is queued.')}
      </Text>
    </Box>
  );
}

function Status({ item }) {
  const s = item.snapshot;
  const mode = MODE_INFO[s.permissionMode] || MODE_INFO.default;
  const ids = [s.chief, ...s.workers, ...Object.keys(s.agents)].filter((id, i, a) => id && a.indexOf(id) === i);
  return (
    <Box flexDirection="column" marginY={1}>
      <Title>{t('Status')}</Title>
      <KV k={t('session')}>
        {item.session.shortId}
        <Text color="gray">{` · ${item.session.title || t('untitled')} · ${tn(item.session.turns, '{n} turn', '{n} turns')}`}</Text>
      </KV>
      <KV k={t('folder')}>{item.root}</KV>
      <KV k={t('status')}>
        <Text color={STATUS_COLORS[s.status]}>{STATUS_LABELS[s.status]}</Text>
        {s.snapshotSha ? <Text color="gray">{` · ${t('/undo reverts it')} (${s.snapshotSha.slice(0, 8)})`}</Text> : null}
      </KV>
      <KV k={t('mode')}>
        <Text color={mode.color}>{mode.label}</Text>
        <Text color="gray">{` · ${mode.hint}`}</Text>
      </KV>
      <KV k="RC">{item.rc === 'on' ? <Text color="green">{t('on')}</Text> : <Text color="gray">{t('off')}</Text>}</KV>
      <KV k={t('settings')}>
        <Text color="gray">{[...(item.sources || []), item.settingsFile].filter(Boolean).join(' · ') || t('defaults')}</Text>
      </KV>
      <Text> </Text>
      <Text bold>{'  '}{t('Agents')}</Text>
      {ids.map((id) => {
        const a = s.agents[id] || {};
        const m = item.models?.[id] || {};
        return (
          <Box key={id} flexDirection="column">
            <Text wrap="truncate-end">
              {'  '}
              <Text color={agentColor(id)} bold>
                {(a.label || id).padEnd(13)}
              </Text>
              <Text color={id === s.chief ? 'yellow' : 'gray'}>{(id === s.chief ? `★ ${t('chief')}` : t('worker')).padEnd(9)}</Text>
              <Text color={a.status === 'unavailable' ? 'red' : a.status === 'cooldown' ? 'yellow' : 'gray'}>
                {AGENT_STATE[a.status] || a.status}
                {a.note ? ` (${a.note})` : ''}
              </Text>
            </Text>
            <Text color="gray" wrap="truncate-end">
              {'    model   '}
              <Text color="white">{m.model}</Text>
            </Text>
            <Text color="gray" wrap="truncate-end">
              {id === 'opencode' ? '    variant ' : '    effort  '}
              <Text color="white">{m.effort}</Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function QuotaBar({ w, now }) {
  const pct = w.used == null ? null : Math.round(w.used * 100);
  const b = bar(w.used, 24);
  return (
    <Text wrap="truncate-end">
      {'    '}
      <Text color="gray">{t(w.label).padEnd(17)}</Text>
      <Text color={usageColor(w.used)}>{b.filled}</Text>
      <Text color="gray">{b.empty}</Text>
      <Text>{` ${pct == null ? '  —' : `${pct}%`.padStart(4)} ${t('used')}`}</Text>
      {w.resetsAt ? <Text color="gray">{` · ${t('resets {when}', { when: resetsIn(w.resetsAt, now) })}`}</Text> : null}
    </Text>
  );
}

/** /usage: plan quota per agent (like Claude Code's /usage) and what this session spent. */
function Usage({ item }) {
  const now = item.now || Date.now();
  return (
    <Box flexDirection="column" marginY={1}>
      <Title>{t('Usage')}</Title>
      {item.rows.map((r) => (
        <Box key={r.id} flexDirection="column" marginTop={1}>
          <Text>
            {'  '}
            <Text color={agentColor(r.id)} bold>
              {r.label}
            </Text>
            {r.plan ? <Text color="gray">{` · ${t('{plan} plan', { plan: r.plan })}`}</Text> : null}
            {r.limitsAt ? <Text color="gray">{` · ${t('measured {when}', { when: relTime(r.limitsAt, now) })}`}</Text> : null}
          </Text>
          {r.windows?.length ? (
            r.windows.map((w) => <QuotaBar key={w.id} w={w} now={now} />)
          ) : (
            <Text color="gray">{`    ${r.note || t('no remaining-limit info')}`}</Text>
          )}
          <Text color="gray" wrap="truncate-end">
            {'    '}
            {t('this session').padEnd(17)}
            {r.usage?.calls
              ? `${fmtTokens(r.usage.input)} ${t('in')} · ${fmtTokens(r.usage.output)} ${t('out')} · ${tn(r.usage.calls, '{n} call', '{n} calls')}${r.usage.cost ? ` · ${fmtCost(r.usage.cost)}` : ''}`
              : t('no calls yet')}
          </Text>
        </Box>
      ))}
      {item.total?.tokens ? (
        <Box marginTop={1}>
          <Text color="gray">{`  ${t('Session total')}: ${fmtTokens(item.total.tokens)} token${item.total.cost ? ` · ${fmtCost(item.total.cost)}` : ''}`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function Doctor({ item }) {
  const icon = (ok) => (ok === true ? <Text color="green">✔</Text> : ok === false ? <Text color="red">✖</Text> : <Text color="yellow">!</Text>);
  return (
    <Box flexDirection="column" marginY={1}>
      <Title>Kerberos doctor</Title>
      {item.checks.map((c, i) => (
        <Text key={i} wrap="wrap">
          {'  '}
          {icon(c.ok)} <Text bold>{c.name.padEnd(14)}</Text>
          <Text color="gray">{c.detail}</Text>
        </Text>
      ))}
    </Box>
  );
}

/** Renders one permanent transcript entry (fed to Ink's <Static>). */
export function TranscriptItem({ item, width }) {
  switch (item.type) {
    case 'banner':
      return <Banner {...item.props} width={width} />;
    case 'resumed':
      return (
        <Box marginBottom={1}>
          <Tree>
            <Text color="gray">{item.text}</Text>
          </Tree>
        </Box>
      );
    case 'user':
      return (
        <Box marginTop={1}>
          <Box width={2} flexShrink={0}>
            <Text color="gray">&gt;</Text>
          </Box>
          <Box flexShrink={1} flexDirection="column">
            {`${item.source === 'telegram' ? '📱 ' : ''}${item.text}`.split('\n').map((l, i) => (
              <Para key={i} segs={[{ text: l, color: 'gray' }]} width={width - 2} />
            ))}
          </Box>
        </Box>
      );
    case 'agent':
      return <AgentMessage item={item} width={width} />;
    case 'plan':
      return <PlanCard plan={item.plan} width={width} />;
    case 'task':
      return (
        <Box marginTop={1}>
          <TaskLine task={item.task} />
        </Box>
      );
    case 'diff':
      return <DiffCard diff={item.diff} tasks={item.tasks} error={item.error} review={item.review} preview={item.preview} />;
    case 'preview':
      return <PreviewCard report={item.report} root={item.root} final={item.final} width={width} />;
    case 'diffText':
      return <DiffText text={item.text} />;
    case 'help':
      return <Help />;
    case 'status':
      return <Status item={item} />;
    case 'usage':
      return <Usage item={item} />;
    case 'doctor':
      return <Doctor item={item} />;
    case 'success':
      return (
        <Box flexDirection="column">
          <Bullet color="green">
            <Para segs={[{ text: item.text, bold: true }]} width={width - Bullet.indent} />
          </Bullet>
          {item.detail && (
            <Tree>
              <Para segs={[{ text: item.detail, color: 'gray' }]} width={width - Tree.indent} />
            </Tree>
          )}
        </Box>
      );
    case 'error':
      return (
        <Bullet color="red">
          <Para segs={[{ text: item.text, color: 'red' }]} width={width - Bullet.indent} />
        </Bullet>
      );
    case 'phase':
      return (
        <Box flexDirection="column">
          <Bullet color={item.color || BRAND}>
            <Para segs={[{ text: item.text, bold: true }]} width={width - Bullet.indent} />
          </Bullet>
          {item.detail && (
            <Tree>
              <Para segs={[{ text: item.detail, color: 'gray' }]} width={width - Tree.indent} />
            </Tree>
          )}
          {item.findings?.length > 0 && <Findings findings={item.findings} width={width - 4} />}
        </Box>
      );
    case 'info':
    default:
      return (
        <Tree color={LEVEL_COLOR[item.level] || 'gray'}>
          <Para segs={[{ text: String(item.text ?? ''), color: LEVEL_COLOR[item.level] || 'gray' }]} width={width - Tree.indent} />
        </Tree>
      );
  }
}
