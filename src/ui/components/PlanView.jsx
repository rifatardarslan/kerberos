import React from 'react';
import { Box, Text } from 'ink';
import { BRAND, BULLET, PLAN, agentColor } from '../theme.js';
import { Bullet, RichText, Tree } from './Blocks.jsx';

function Section({ title, items, color }) {
  if (!items?.length) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{title}</Text>
      {items.map((it, i) => (
        <Text key={i} wrap="wrap">
          <Text color={color || 'gray'}>{'  - '}</Text>
          {it}
        </Text>
      ))}
    </Box>
  );
}

/** Consensus plan, shown like Claude Code's plan-mode box. */
export function PlanCard({ plan, width }) {
  const files = plan.files_to_modify || [];
  return (
    <Box flexDirection="column">
      <Bullet color={PLAN}>
        <Text>
          <Text bold>Plan hazır</Text>
          <Text color="gray">{files.length ? ` · ${files.length} dosya` : ' · dosya değişikliği yok'}</Text>
        </Text>
      </Bullet>
      <Box borderStyle="round" borderColor={PLAN} flexDirection="column" paddingX={1} marginLeft={2} width={Math.min(width - 2, 110)}>
        <RichText text={plan.summary || ''} />
        <Section title="Sorular" items={plan.questions} color="yellow" />
        <Section title="Dosyalar" items={files} color={PLAN} />
        <Section title="Bağımlılıklar" items={plan.dependencies} />
        <Section title="Riskler" items={plan.risks} color="red" />
        <Section title="Adımlar" items={plan.steps} />
      </Box>
    </Box>
  );
}

const STATUS_STYLE = {
  A: { color: 'green', label: 'yeni' },
  M: { color: 'yellow', label: 'değişti' },
  D: { color: 'red', label: 'silindi' },
  R: { color: 'cyan', label: 'taşındı' },
};

/** Summary after a build: files with +/- counts. */
export function DiffCard({ diff, tasks = [], error }) {
  const files = diff?.files || [];
  const added = files.reduce((n, f) => n + (f.added || 0), 0);
  const removed = files.reduce((n, f) => n + (f.removed || 0), 0);
  const failed = tasks.filter((t) => t.status === 'failed');
  const pad = Math.min(48, Math.max(8, ...files.map((f) => f.path.length)));

  return (
    <Box flexDirection="column">
      <Bullet color={error ? 'yellow' : 'green'}>
        <Text>
          <Text bold>{error ? 'Kodlama kısmen tamamlandı' : 'Kodlama tamamlandı'}</Text>
          <Text color="gray">{` · ${files.length} dosya · `}</Text>
          <Text color="green">+{added}</Text>
          <Text color="gray"> </Text>
          <Text color="red">−{removed}</Text>
        </Text>
      </Bullet>
      <Tree>
        {files.length === 0 && <Text color="gray">değişiklik yok</Text>}
        {files.map((f) => {
          const st = STATUS_STYLE[f.status] || { color: 'white', label: f.status };
          return (
            <Text key={f.path} wrap="truncate-end">
              <Text color={st.color}>{f.status} </Text>
              <Text>{f.path.padEnd(pad)} </Text>
              {f.added > 0 && <Text color="green">+{f.added} </Text>}
              {f.removed > 0 && <Text color="red">−{f.removed} </Text>}
              <Text color="gray">{st.label}</Text>
            </Text>
          );
        })}
        {failed.map((t) => (
          <Text key={t.file_path} color="red">
            {t.file_path} yazılamadı
          </Text>
        ))}
        {files.length > 0 && <Text color="gray">/undo ile geri alınır</Text>}
      </Tree>
    </Box>
  );
}

/** Unified diff with +/- colouring (for /diff). */
export function DiffText({ text }) {
  const lines = text.split('\n');
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={BRAND}>{BULLET} </Text>
        <Text bold>Diff</Text>
      </Text>
      {lines.map((l, i) => {
        let color;
        let bold = false;
        if (l.startsWith('diff --git')) bold = true;
        else if (l.startsWith('+++') || l.startsWith('---')) color = 'gray';
        else if (l.startsWith('+')) color = 'green';
        else if (l.startsWith('-')) color = 'red';
        else if (l.startsWith('@@')) color = 'cyan';
        else if (/^(index|new file|deleted file)/.test(l)) color = 'gray';
        return (
          <Text key={i} color={color} bold={bold} wrap="truncate-end">
            {'  '}
            {l || ' '}
          </Text>
        );
      })}
    </Box>
  );
}

/** One task line in the transcript: ● Write(path) / ● Update(path). */
export function TaskLine({ task }) {
  const ok = task.status === 'done';
  const verb = task.existed || task.action === 'update_file' ? 'Update' : 'Write';
  const who = task.worker || task.target_worker;
  return (
    <Box flexDirection="column">
      <Bullet color={ok ? 'green' : 'red'} marginTop={0}>
        <Text wrap="truncate-end">
          <Text bold>{verb}</Text>
          <Text>({task.file_path})</Text>
        </Text>
      </Bullet>
      <Tree>
        <Text>
          {ok ? (
            <Text>
              <Text bold>{task.lines ?? '?'}</Text>
              <Text color="gray"> satır yazıldı · </Text>
            </Text>
          ) : (
            <Text color="red">yazılamadı · </Text>
          )}
          <Text color={agentColor(who)}>{task.workerLabel || who}</Text>
        </Text>
      </Tree>
    </Box>
  );
}
