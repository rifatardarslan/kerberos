import React from 'react';
import { Box, Text } from 'ink';
import { BRAND, BULLET, MODE_INFO, STATUS_COLORS, STATUS_LABELS, agentColor, bar, fmtCost, fmtTokens, relTime, resetsIn, usageColor } from '../theme.js';
import { COMMANDS } from '../commands.js';
import { Banner } from './Header.jsx';
import { PlanCard, DiffCard, DiffText, TaskLine } from './PlanView.jsx';
import { Bullet, RichText, Tree } from './Blocks.jsx';

const ROLE = { chief: 'şef', worker: 'işçi' };
const STEP = { draft: 'taslak', critique: 'eleştiri', revise: 'revizyon', synthesize: 'sentez', decompose: 'görev dağıtımı', code: 'kod', compact: 'bağlam özeti', triage: 'değerlendirme', reply: 'yanıt', solve: 'çözüm', answer: 'çözüm', final: 'sonuç' };
const PREVIEW_LINES = 4; // intermediate outputs are folded like Claude Code's tool results
// Replies meant for the user: printed like Claude's own answer ("● text"), never folded.
export const ANSWER_STEPS = new Set(['reply', 'final']);

const AGENT_STATE = { idle: 'hazır', busy: 'çalışıyor', cooldown: 'beklemede', unavailable: 'kullanılamıyor' };

function secs(ms) {
  return ms == null ? '' : ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

/**
 * An answer for the user reads like Claude's own reply; every other agent output
 * looks like a tool call, folded to a few lines (ctrl+o reprints the last one whole).
 */
function AgentMessage({ item }) {
  if (ANSWER_STEPS.has(item.step)) {
    return (
      <Bullet>
        <RichText text={item.text} />
      </Bullet>
    );
  }
  const lines = item.text.split('\n');
  const cut = !item.full && lines.length > PREVIEW_LINES + 1;
  const text = cut ? lines.slice(0, PREVIEW_LINES).join('\n') : item.text;
  const tok = item.usage ? (item.usage.input || 0) + (item.usage.output || 0) : 0;
  const what = (item.step && STEP[item.step]) || ROLE[item.role] || item.role;
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
        {item.text.trim() ? <RichText text={text} /> : <Text color="gray">(boş yanıt)</Text>}
        {cut && <Text color="gray">{`… +${lines.length - PREVIEW_LINES} satır (ctrl+o ile genişlet)`}</Text>}
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

const HELP_KEYS = [
  ['/', 'komut menüsü (↑↓ seç, tab tamamla)'],
  ['@', 'dosya ekle: içeriği ajanlara gönderilir'],
  ['shift+tab', 'mod: onaylı → otomatik → yalnızca plan'],
  ['ctrl+r', 'önceki promptlarda ara'],
  ['ctrl+o', 'kısaltılmış son çıktıyı tam göster'],
  ['\\ + enter', 'yeni satır'],
];

function Help() {
  const pad = Math.max(...COMMANDS.map((c) => (c.name + (c.args ? ` ${c.args}` : '')).length)) + 2;
  return (
    <Box flexDirection="column" marginY={1}>
      <Title>Komutlar</Title>
      {COMMANDS.map((c) => (
        <Text key={c.name} wrap="truncate-end">
          {'  '}
          <Text color={BRAND}>/{(c.name + (c.args ? ` ${c.args}` : '')).padEnd(pad)}</Text>
          <Text color="gray">{c.desc}</Text>
          {c.aliases ? <Text color="gray"> ({c.aliases.map((a) => `/${a}`).join(', ')})</Text> : null}
        </Text>
      ))}
      <Text> </Text>
      <Text bold>{'  '}Kısayollar</Text>
      {HELP_KEYS.map(([k, d]) => (
        <Text key={k}>
          {'  '}
          <Text color={BRAND}>{k.padEnd(pad + 1)}</Text>
          <Text color="gray">{d}</Text>
        </Text>
      ))}
      <Text> </Text>
      <Text color="gray" wrap="wrap">
        {'  '}Düz metin yazmak görev başlatır; ajanlar oturumdaki önceki turları hatırlar. Çalışırken yazılanlar kuyruğa alınır.
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
      <Title>Durum</Title>
      <KV k="oturum">
        {item.session.shortId}
        <Text color="gray">{` · ${item.session.title || 'başlıksız'} · ${item.session.turns} tur`}</Text>
      </KV>
      <KV k="dizin">{item.root}</KV>
      <KV k="durum">
        <Text color={STATUS_COLORS[s.status]}>{STATUS_LABELS[s.status]}</Text>
        {s.snapshotSha ? <Text color="gray">{` · /undo ile geri alınabilir (${s.snapshotSha.slice(0, 8)})`}</Text> : null}
      </KV>
      <KV k="mod">
        <Text color={mode.color}>{mode.label}</Text>
        <Text color="gray">{` · ${mode.hint}`}</Text>
      </KV>
      <KV k="RC">{item.rc === 'on' ? <Text color="green">açık</Text> : <Text color="gray">kapalı</Text>}</KV>
      <KV k="ayarlar">
        <Text color="gray">{[...(item.sources || []), item.settingsFile].filter(Boolean).join(' · ') || 'varsayılanlar'}</Text>
      </KV>
      <Text> </Text>
      <Text bold>{'  '}Ajanlar</Text>
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
              <Text color={id === s.chief ? 'yellow' : 'gray'}>{(id === s.chief ? '★ şef' : 'işçi').padEnd(7)}</Text>
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
      <Text color="gray">{w.label.padEnd(17)}</Text>
      <Text color={usageColor(w.used)}>{b.filled}</Text>
      <Text color="gray">{b.empty}</Text>
      <Text>{` ${pct == null ? '  —' : `%${pct}`.padStart(4)} kullanıldı`}</Text>
      {w.resetsAt ? <Text color="gray">{` · sıfırlanma ${resetsIn(w.resetsAt, now)}`}</Text> : null}
    </Text>
  );
}

/** /usage: plan quota per agent (like Claude Code's /usage) and what this session spent. */
function Usage({ item }) {
  const now = item.now || Date.now();
  return (
    <Box flexDirection="column" marginY={1}>
      <Title>Kullanım</Title>
      {item.rows.map((r) => (
        <Box key={r.id} flexDirection="column" marginTop={1}>
          <Text>
            {'  '}
            <Text color={agentColor(r.id)} bold>
              {r.label}
            </Text>
            {r.plan ? <Text color="gray">{` · ${r.plan} planı`}</Text> : null}
            {r.limitsAt ? <Text color="gray">{` · ${relTime(r.limitsAt, now)} ölçüldü`}</Text> : null}
          </Text>
          {r.windows?.length ? (
            r.windows.map((w) => <QuotaBar key={w.id} w={w} now={now} />)
          ) : (
            <Text color="gray">{`    ${r.note || 'kalan limit bilgisi yok'}`}</Text>
          )}
          <Text color="gray" wrap="truncate-end">
            {'    '}
            {'bu oturum'.padEnd(17)}
            {r.usage?.calls
              ? `${fmtTokens(r.usage.input)} giriş · ${fmtTokens(r.usage.output)} çıkış · ${r.usage.calls} çağrı${r.usage.cost ? ` · ${fmtCost(r.usage.cost)}` : ''}`
              : 'henüz çağrı yok'}
          </Text>
        </Box>
      ))}
      {item.total?.tokens ? (
        <Box marginTop={1}>
          <Text color="gray">{`  Oturum toplamı: ${fmtTokens(item.total.tokens)} token${item.total.cost ? ` · ${fmtCost(item.total.cost)}` : ''}`}</Text>
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
          <Box flexShrink={1}>
            <Text color="gray" wrap="wrap">
              {item.source === 'telegram' ? '📱 ' : ''}
              {item.text}
            </Text>
          </Box>
        </Box>
      );
    case 'agent':
      return <AgentMessage item={item} />;
    case 'plan':
      return <PlanCard plan={item.plan} width={width} />;
    case 'task':
      return (
        <Box marginTop={1}>
          <TaskLine task={item.task} />
        </Box>
      );
    case 'diff':
      return <DiffCard diff={item.diff} tasks={item.tasks} error={item.error} />;
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
            <Text bold>{item.text}</Text>
          </Bullet>
          {item.detail && (
            <Tree>
              <Text color="gray">{item.detail}</Text>
            </Tree>
          )}
        </Box>
      );
    case 'error':
      return (
        <Bullet color="red">
          <Text color="red" wrap="wrap">
            {item.text}
          </Text>
        </Bullet>
      );
    case 'phase':
      return (
        <Box flexDirection="column">
          <Bullet color={item.color || BRAND}>
            <Text bold wrap="wrap">
              {item.text}
            </Text>
          </Bullet>
          {item.detail && (
            <Tree>
              <Text color="gray" wrap="wrap">
                {item.detail}
              </Text>
            </Tree>
          )}
        </Box>
      );
    case 'info':
    default:
      return (
        <Tree color={LEVEL_COLOR[item.level] || 'gray'}>
          <Text color={LEVEL_COLOR[item.level] || 'gray'} wrap="wrap">
            {item.text}
          </Text>
        </Tree>
      );
  }
}
