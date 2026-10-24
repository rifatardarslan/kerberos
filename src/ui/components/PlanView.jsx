import React from 'react';
import { Box, Text } from 'ink';
import { agentColor, wrapLine } from '../theme.js';

const TASK_ICON = { pending: '·', running: '◐', done: '✔', failed: '✖' };
const TASK_COLOR = { pending: 'gray', running: 'yellow', done: 'green', failed: 'red' };
const DIFF_COLOR = { A: 'green', M: 'yellow', D: 'red', R: 'cyan' };

/**
 * Builds a flat list of single-line rows, then shows as many as fit. Rendering a
 * fixed number of rows avoids Ink shrinking (and overlapping) overflowing children.
 */
function buildRows(state) {
  const { plan, tasks, diff, status } = state;
  const rows = [];
  const add = (text, props = {}) => rows.push({ text, props });
  const section = (title, items, color) => {
    if (!items?.length) return;
    add('');
    add(title, { bold: true });
    items.forEach((it) => add(` • ${it}`, { color }));
  };

  add(status === 'DONE' ? 'SONUÇ' : status === 'BUILDING' ? 'KODLAMA' : 'KONSENSÜS PLANI', { bold: true, color: 'magenta' });
  if (plan?.summary) add(plan.summary, { wrap: true });

  if (plan && status !== 'DONE' && status !== 'BUILDING') {
    if (plan.questions?.length) {
      section('❓ Sorular (yanıtınızı yazıp Enter)', plan.questions, 'yellow');
    }
    if (!plan.files_to_modify?.length) {
      add('');
      add('Dosya değişikliği yok', { color: 'gray' });
    }
    section('Dosyalar', plan.files_to_modify, 'cyan');
    section('Bağımlılıklar', plan.dependencies, 'yellow');
    section('Riskler', plan.risks, 'red');
  }

  if (tasks?.length && ['BUILDING', 'DONE', 'ABORTED', 'ERROR'].includes(status)) {
    add('');
    add('Görevler', { bold: true });
    tasks.forEach((t) => rows.push({ task: t }));
  }

  if (diff) {
    add('');
    add('Diff', { bold: true });
    if (!diff.files.length) add(' değişiklik yok', { color: 'gray' });
    diff.files.forEach((f) => add(` ${f.status} ${f.path}`, { color: DIFF_COLOR[f.status] || 'white' }));
    const last = diff.stat.split('\n').pop();
    if (last) add(last.trim(), { color: 'gray' });
  }

  if (state.error) {
    add('');
    add(`⚠ ${state.error}`, { color: 'red', wrap: true });
  }
  return rows;
}

export function PlanView({ state, width, height }) {
  const inner = Math.max(10, width - 4);
  const rows = [];
  for (const r of buildRows(state)) {
    if (r.props?.wrap) wrapLine(r.text, inner).forEach((t) => rows.push({ ...r, text: t }));
    else rows.push(r);
  }
  const visible = Math.max(1, height - 2);
  const shown = rows.slice(0, visible);
  const hidden = rows.length - shown.length;
  if (hidden > 0) shown[shown.length - 1] = { text: `… +${hidden + 1} satır`, props: { color: 'gray' } };

  return (
    <Box borderStyle="round" borderColor="magenta" flexDirection="column" paddingX={1} width={width} height={height} flexShrink={0}>
      {shown.map((r, i) =>
        r.task ? (
          <Text key={i} wrap="truncate-end">
            <Text color={TASK_COLOR[r.task.status]}> {TASK_ICON[r.task.status]} </Text>
            <Text>{r.task.file_path} </Text>
            <Text color={agentColor(r.task.worker || r.task.target_worker)}>@{r.task.worker || r.task.target_worker}</Text>
          </Text>
        ) : (
          <Text key={i} wrap="truncate-end" bold={r.props.bold} color={r.props.color}>
            {r.text || ' '}
          </Text>
        ),
      )}
    </Box>
  );
}
