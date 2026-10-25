import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { SUGGEST } from '../theme.js';
import { Para } from './Blocks.jsx';

/**
 * The chief's clarifying questions, in the style of Claude Code's AskUserQuestion:
 *
 *   ☒ Tema  ☐ Sayfalar
 *   Hangi sayfalar?
 *   ❯ 1. [✓] Blog
 *     2. [ ] Projeler
 *     3. Diğer: kendim yazayım
 *     4. Tamam
 *
 * ↑↓ / number keys move, enter picks (toggles for multi-select), esc hides the box
 * and leaves the prompt for a typed answer. `index` is the open question.
 */
export function QuestionPrompt({ questions, answers, index, onAnswer, onOther, onHide, width = 80, color = SUGGEST }) {
  const q = questions[index];
  const multi = Boolean(q.multiSelect);
  const rows = [...q.options.map((o) => ({ ...o, kind: 'option' })), { label: 'Diğer: kendim yazayım', kind: 'other' }, ...(multi ? [{ label: 'Tamam', kind: 'done' }] : [])];
  const [cursor, setCursor] = useState(0);
  const [picked, setPicked] = useState(() => new Set());
  const inner = Math.max(20, Math.min(width - 2, 100) - 6);

  const choose = (i) => {
    const row = rows[i];
    if (row.kind === 'other') return onOther();
    if (row.kind === 'done') {
      if (!picked.size) return undefined;
      return onAnswer(q.options.filter((_, k) => picked.has(k)).map((o) => o.label));
    }
    if (!multi) return onAnswer(row.label);
    const next = new Set(picked);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    return setPicked(next);
  };

  useInput((input, key) => {
    if (key.escape) return onHide();
    if (key.upArrow) return setCursor((c) => (c - 1 + rows.length) % rows.length);
    if (key.downArrow || key.tab) return setCursor((c) => (c + 1) % rows.length);
    if (key.return || (multi && input === ' ')) return choose(cursor);
    const n = Number(input);
    if (n >= 1 && n <= rows.length) {
      setCursor(n - 1);
      choose(n - 1);
    }
    return undefined;
  });

  return (
    <Box borderStyle="round" borderColor={color} flexDirection="column" paddingX={2} marginTop={1} width={Math.min(width - 2, 100)}>
      {questions.length > 1 && (
        <Text wrap="truncate-end">
          {questions.map((x, i) => {
            const done = answers[i] != null;
            return (
              <Text key={i} color={i === index ? color : done ? 'green' : 'gray'} bold={i === index}>
                {`${done ? '☒' : '☐'} ${x.header || `Soru ${i + 1}`}  `}
              </Text>
            );
          })}
        </Text>
      )}
      <Box marginTop={questions.length > 1 ? 1 : 0} flexDirection="column">
        <Para segs={[{ text: q.question, bold: true }]} width={inner} />
      </Box>
      <Text> </Text>
      {rows.map((row, i) => {
        const sel = i === cursor;
        const box = multi && row.kind === 'option' ? (picked.has(i) ? '[✓] ' : '[ ] ') : '';
        return (
          <Box key={i} flexDirection="column">
            <Text wrap="truncate-end">
              <Text color={sel ? color : 'gray'}>{sel ? '❯ ' : '  '}</Text>
              <Text color={sel ? color : row.kind === 'option' ? undefined : 'gray'} bold={sel}>
                {`${i + 1}. ${box}${row.label}`}
              </Text>
            </Text>
            {row.description ? <Para segs={[{ text: row.description, color: 'gray' }]} width={inner} marker={'     '} /> : null}
          </Box>
        );
      })}
      <Text> </Text>
      <Text color="gray">{multi ? 'enter/boşluk işaretle · Tamam gönderir · esc yaz' : 'enter seç · esc kendin yaz'}</Text>
    </Box>
  );
}
