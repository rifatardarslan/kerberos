import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { SUGGEST } from '../theme.js';
import { Para } from './Blocks.jsx';
import { t } from '../../i18n/index.js';

const isAnswered = (a) => a != null && (Array.isArray(a) ? a.length > 0 : String(a).trim() !== '');
const show = (a) => [].concat(a).join(', ');

/**
 * The chief's clarifying questions, in the style of Claude Code's AskUserQuestion:
 *
 *   ←  ☒ Theme   ☐ Pages   ✔ Submit  →
 *
 *   Which pages?
 *   ❯ 1. [✓] Blog
 *     2. [ ] Projects
 *     3. Other: ▏
 *     4. Next →
 *
 * ←/→ switch between questions (answers can be changed until they are sent), ↑↓ or a
 * number picks, "Other" is typed in place. The last tab reviews and sends all answers.
 * A single single-choice question is sent as soon as it is answered. Esc hides the box
 * (the prompt then answers the open question).
 */
export function QuestionPrompt({ questions, answers = [], onSubmit, onCancel, onHide, width = 80, color = SUGGEST }) {
  const single = questions.length === 1 && !questions[0].multiSelect;
  const submitTab = single ? -1 : questions.length;
  const [tab, setTab] = useState(() => Math.max(0, questions.findIndex((_, i) => !isAnswered(answers[i]))));
  const [drafts, setDrafts] = useState(() => questions.map((_, i) => answers[i] ?? null));
  const [cursor, setCursor] = useState(0);
  const [other, setOther] = useState(() => questions.map(() => ''));
  const boxWidth = Math.min(width - 2, 100);
  const inner = Math.max(20, boxWidth - 6);

  // Answers that came in from Telegram fill the questions not answered here yet.
  const value = (i) => drafts[i] ?? answers[i] ?? null;
  const all = questions.map((_, i) => value(i));
  const complete = all.every(isAnswered);

  const q = questions[tab];
  const multi = Boolean(q?.multiSelect);
  const rows =
    tab === submitTab
      ? [
          { label: t('Submit answers'), kind: 'send', disabled: !complete },
          { label: t('Cancel'), kind: 'cancel' },
        ]
      : [...q.options.map((o) => ({ ...o, kind: 'option' })), { label: t('Other'), kind: 'other' }, ...(multi ? [{ label: t('Next →'), kind: 'next' }] : [])];

  const goTo = (t, filled = all) => {
    const next = Math.max(0, Math.min(t, single ? 0 : questions.length));
    setTab(next);
    setCursor(next === submitTab ? (filled.every(isAnswered) ? 0 : 1) : 0);
  };
  /** After an answer: the next unanswered question, else the review tab. */
  const advance = (filled) => {
    if (single) return onSubmit(filled);
    const nextOpen = filled.findIndex((a, i) => i > tab && !isAnswered(a));
    const firstOpen = filled.findIndex((a) => !isAnswered(a));
    return goTo(nextOpen >= 0 ? nextOpen : firstOpen >= 0 && firstOpen !== tab ? firstOpen : submitTab, filled);
  };
  const record = (a) => {
    const filled = all.map((x, i) => (i === tab ? a : x));
    setDrafts(filled);
    return filled;
  };

  const choose = (i) => {
    const row = rows[i];
    if (!row || row.disabled) return undefined;
    if (row.kind === 'send') return onSubmit(all);
    if (row.kind === 'cancel') return onCancel();
    if (row.kind === 'next') return advance(all);
    if (row.kind === 'other') {
      const text = other[tab].trim();
      return text ? advance(record(multi ? [...[].concat(value(tab) || []).filter((l) => q.options.some((o) => o.label === l)), text] : text)) : undefined;
    }
    if (!multi) return advance(record(row.label));
    const cur = [].concat(value(tab) || []);
    record(cur.includes(row.label) ? cur.filter((l) => l !== row.label) : [...cur, row.label]);
    return undefined;
  };

  useInput((input, key) => {
    if (key.escape) return onHide();
    if (key.leftArrow) return goTo(tab - 1);
    if (key.rightArrow || key.tab) return goTo(tab + 1);
    if (key.upArrow) return setCursor((c) => (c - 1 + rows.length) % rows.length);
    if (key.downArrow) return setCursor((c) => (c + 1) % rows.length);
    const onOther = rows[cursor]?.kind === 'other';
    if (onOther && (key.backspace || key.delete)) return setOther((o) => o.map((t, i) => (i === tab ? t.slice(0, -1) : t)));
    if (key.return || (multi && !onOther && input === ' ')) return choose(cursor);
    if (onOther && input && !key.ctrl && !key.meta) return setOther((o) => o.map((t, i) => (i === tab ? t + input.replace(/[\r\n]/g, ' ') : t)));
    const n = Number(input);
    if (n >= 1 && n <= rows.length) {
      setCursor(n - 1);
      if (rows[n - 1].kind !== 'other') choose(n - 1);
    }
    return undefined;
  });

  const tabs = !single && (
    <Text wrap="truncate-end">
      <Text color="gray">{'←  '}</Text>
      {questions.map((x, i) => (
        <Text key={i} color={i === tab ? color : isAnswered(value(i)) ? 'green' : 'gray'} bold={i === tab} inverse={i === tab}>
          {` ${isAnswered(value(i)) ? '☒' : '☐'} ${x.header || t('Question {n}', { n: i + 1 })} `}
        </Text>
      ))}
      <Text> </Text>
      <Text color={tab === submitTab ? color : complete ? 'green' : 'gray'} bold={tab === submitTab} inverse={tab === submitTab}>
        {` ✔ ${t('Submit')} `}
      </Text>
      <Text color="gray">{'  →'}</Text>
    </Text>
  );

  return (
    <Box borderStyle="round" borderColor={color} flexDirection="column" paddingX={2} marginTop={1} width={boxWidth}>
      {tabs}
      <Box marginTop={tabs ? 1 : 0} flexDirection="column">
        {tab === submitTab ? (
          <>
            <Text bold>{t('Review your answers')}</Text>
            {questions.map((x, i) => (
              <Box key={i} flexDirection="column" marginTop={1}>
                <Para segs={[{ text: x.question }]} width={inner} marker="● " markerColor={isAnswered(value(i)) ? 'green' : 'yellow'} />
                <Para segs={[{ text: isAnswered(value(i)) ? show(value(i)) : t('not answered'), color: isAnswered(value(i)) ? color : 'yellow' }]} width={inner} marker="  → " />
              </Box>
            ))}
          </>
        ) : (
          <Para segs={[{ text: q.question, bold: true }]} width={inner} />
        )}
      </Box>
      <Text> </Text>
      {rows.map((row, i) => {
        const sel = i === cursor;
        const picked = [].concat(value(tab) || []);
        const box = multi && row.kind === 'option' ? (picked.includes(row.label) ? '[✓] ' : '[ ] ') : '';
        const chosen = !multi && row.kind === 'option' && value(tab) === row.label;
        const typed = row.kind === 'other' ? other[tab] : '';
        return (
          <Box key={i} flexDirection="column">
            <Text wrap="truncate-end">
              <Text color={sel ? color : 'gray'}>{sel ? '❯ ' : '  '}</Text>
              <Text color={row.disabled ? 'gray' : sel ? color : row.kind === 'option' ? undefined : 'gray'} bold={sel && !row.disabled} dimColor={row.disabled}>
                {`${i + 1}. ${box}${row.label}`}
              </Text>
              {chosen && <Text color="green"> ✓</Text>}
              {row.kind === 'other' && (
                <Text>
                  <Text color="gray">: </Text>
                  <Text>{typed}</Text>
                  {sel ? <Text inverse> </Text> : !typed ? <Text color="gray">{t('type your own answer')}</Text> : null}
                </Text>
              )}
            </Text>
            {row.description ? <Para segs={[{ text: row.description, color: 'gray' }]} width={inner} marker="     " /> : null}
          </Box>
        );
      })}
      <Text> </Text>
      <Text color="gray">
        {tab === submitTab
          ? t('← back · enter submit · esc hide')
          : `${single ? '' : `${t('←→ questions')} · `}${t(multi ? 'enter/space toggle' : 'enter select')} · ${t('esc hide')}`}
      </Text>
    </Box>
  );
}
