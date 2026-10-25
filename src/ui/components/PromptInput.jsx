import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';

const WORD = /[\p{L}\p{N}_]/u;
// Backspace and ctrl+backspace arrive as \b and DEL, the other way round on Windows
// (the console keyboard layout gives ctrl+backspace DEL) than on Unix terminals
// (backspace is DEL there). Ink reports both as one-character deletes.
const WORD_BACKSPACE = process.platform === 'win32' ? '\x7f' : '\b';
const FORWARD_DELETE = '\x1b[3~';

function lineBounds(value, cursor) {
  const start = value.lastIndexOf('\n', cursor - 1) + 1;
  const nl = value.indexOf('\n', cursor);
  return { start, end: nl === -1 ? value.length : nl };
}

function wordLeft(value, cursor) {
  let i = cursor;
  while (i > 0 && !WORD.test(value[i - 1])) i--;
  while (i > 0 && WORD.test(value[i - 1])) i--;
  return i;
}

function wordRight(value, cursor) {
  let i = cursor;
  while (i < value.length && !WORD.test(value[i])) i++;
  while (i < value.length && WORD.test(value[i])) i++;
  return i;
}

/**
 * Multi-line prompt in Claude Code style:
 *   enter submits · "\" + enter, alt+enter or a paste inserts a newline
 *   ←/→, home/end, ctrl+a/e, alt+←/→ (word), ctrl+u/k/w, ctrl+d / delete (forward)
 *   ctrl+backspace, alt+backspace: delete the word before the cursor
 * ↑/↓ move between lines; on the first/last line they go to `onEdge('up'|'down')`
 * (history). Escape, tab and ctrl+c are left to the parent.
 */
export function PromptInput({ value, onChange, onSubmit, onEdge, placeholder = '', focus = true, accent, arrowsToParent = false, width = 80 }) {
  const [cursor, setCursor] = useState(value.length);
  const own = useRef(value);

  // The raw sequence of the key being handled: Ink's key flags cannot tell
  // backspace from ctrl+backspace, or backspace from the Delete key.
  const { internal_eventEmitter: events } = useStdin();
  const raw = useRef('');
  useEffect(() => {
    if (!events) return undefined;
    const remember = (data) => {
      raw.current = String(data);
    };
    events.prependListener('input', remember); // before useInput's own listener
    return () => events.removeListener('input', remember);
  }, [events]);

  // Programmatic changes (history, completion, clear) put the cursor at the end.
  useEffect(() => {
    if (value !== own.current) {
      own.current = value;
      setCursor(value.length);
    }
  }, [value]);

  const c = Math.min(cursor, value.length);
  const commit = (next, at) => {
    own.current = next;
    setCursor(at);
    if (next !== value) onChange(next);
  };

  useInput(
    (input, key) => {
      if (key.escape || (key.ctrl && input === 'c') || key.tab) return;
      if ((key.upArrow || key.downArrow) && arrowsToParent) return;

      if (key.return) {
        if (key.meta) return commit(value.slice(0, c) + '\n' + value.slice(c), c + 1);
        if (c > 0 && value[c - 1] === '\\') return commit(value.slice(0, c - 1) + '\n' + value.slice(c), c);
        return onSubmit(value);
      }
      if (key.upArrow || key.downArrow) {
        const { start, end } = lineBounds(value, c);
        const col = c - start;
        if (key.upArrow) {
          if (start === 0) return onEdge?.('up');
          const prev = lineBounds(value, start - 1);
          return setCursor(Math.min(prev.start + col, prev.end));
        }
        if (end === value.length) return onEdge?.('down');
        const next = lineBounds(value, end + 1);
        return setCursor(Math.min(next.start + col, next.end));
      }
      if (key.leftArrow) return setCursor(key.meta || key.ctrl ? wordLeft(value, c) : Math.max(0, c - 1));
      if (key.rightArrow) return setCursor(key.meta || key.ctrl ? wordRight(value, c) : Math.min(value.length, c + 1));
      if (key.home || (key.ctrl && input === 'a')) return setCursor(lineBounds(value, c).start);
      if (key.end || (key.ctrl && input === 'e')) return setCursor(lineBounds(value, c).end);
      if (key.ctrl && input === 'u') {
        const { start } = lineBounds(value, c);
        return commit(value.slice(0, start) + value.slice(c), start);
      }
      if (key.ctrl && input === 'k') {
        const { end } = lineBounds(value, c);
        return commit(value.slice(0, c) + value.slice(end), c);
      }
      if ((key.ctrl && input === 'w') || (key.meta && (key.backspace || key.delete)) || raw.current === WORD_BACKSPACE) {
        const w = wordLeft(value, c);
        return commit(value.slice(0, w) + value.slice(c), w);
      }
      if ((key.ctrl && input === 'd') || raw.current === FORWARD_DELETE) return commit(value.slice(0, c) + value.slice(c + 1), c);
      if (key.backspace || key.delete) {
        if (c === 0) return;
        return commit(value.slice(0, c - 1) + value.slice(c), c - 1);
      }
      if (key.ctrl || key.meta || !input) return;

      // Typed or pasted text; pasted line breaks stay line breaks instead of submitting.
      const text = input.replace(/\r\n?/g, '\n');
      commit(value.slice(0, c) + text + value.slice(c), c + text.length);
    },
    { isActive: focus },
  );

  const lines = value.split('\n');
  let offset = 0;
  // Claude Code draws the prompt between two plain rules, not in a box.
  const rule = (
    <Text color={accent || 'gray'} dimColor={!accent}>
      {'─'.repeat(Math.max(10, width))}
    </Text>
  );
  return (
    <Box marginTop={1} flexDirection="column">
      {rule}
      {value === '' ? (
        <Text>
          <Text color={accent}>{'> '}</Text>
          {focus ? <Text inverse>{placeholder[0] || ' '}</Text> : null}
          <Text color="gray">{focus ? placeholder.slice(1) : placeholder}</Text>
        </Text>
      ) : (
        lines.map((line, i) => {
          const from = offset;
          offset += line.length + 1;
          const here = focus && c >= from && c <= from + line.length;
          const at = c - from;
          return (
            <Text key={i} wrap="wrap">
              <Text color={accent}>{i === 0 ? '> ' : '  '}</Text>
              {here ? (
                <>
                  {line.slice(0, at)}
                  <Text inverse>{line[at] || ' '}</Text>
                  {line.slice(at + 1)}
                </>
              ) : (
                line
              )}
            </Text>
          );
        })
      )}
      {rule}
    </Box>
  );
}
