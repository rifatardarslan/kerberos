import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { BULLET, SUGGEST } from '../theme.js';

// Building blocks shared by the transcript entries: Claude Code's "●" and "⎿" layout
// and a small Markdown renderer.
//
// Text is wrapped here rather than by Ink: Ink keeps the space it breaks at, so every
// wrapped line would start one column too far right, and list items would not hang
// under their first line.

/** **bold** and `code` inline formatting, as styled segments. */
export function parseInline(text, base = {}) {
  const segs = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) segs.push({ ...base, text: text.slice(last, m.index) });
    const tok = m[0];
    segs.push(tok.startsWith('**') ? { ...base, text: tok.slice(2, -2), bold: true } : { ...base, text: tok.slice(1, -1), color: SUGGEST });
    last = m.index + tok.length;
  }
  if (last < text.length) segs.push({ ...base, text: text.slice(last) });
  return segs;
}

/** Split a word wider than `width` into pieces that fit. */
function hardSplit(word, width) {
  const out = [];
  let cur = '';
  for (const ch of word) {
    if (cur && stringWidth(cur + ch) > width) {
      out.push(cur);
      cur = '';
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Word-wrap styled segments to `width` columns; no line starts with a space. */
export function wrapSegments(segs, width) {
  const lines = [];
  let line = [];
  let used = 0;
  let space = null; // a space waiting to see whether the next word fits
  const push = (seg, w) => {
    const prev = line[line.length - 1];
    if (prev && prev.bold === seg.bold && prev.color === seg.color && prev.dim === seg.dim) prev.text += seg.text;
    else line.push({ ...seg });
    used += w;
  };
  const breakLine = () => {
    lines.push(line);
    line = [];
    used = 0;
    space = null;
  };
  for (const seg of segs) {
    for (const tok of seg.text.split(/(\s+)/)) {
      if (!tok) continue;
      if (/^\s+$/.test(tok)) {
        if (used) space = { ...seg, text: ' ' };
        continue;
      }
      const w = stringWidth(tok);
      if (used && used + (space ? 1 : 0) + w > width) breakLine();
      const pieces = w > width ? hardSplit(tok, width) : [tok];
      pieces.forEach((piece, i) => {
        if (i > 0) breakLine();
        if (space && used) push(space, 1);
        space = null;
        push({ ...seg, text: piece }, stringWidth(piece));
      });
    }
  }
  if (line.length || !lines.length) lines.push(line);
  return lines;
}

function Segs({ segs }) {
  if (!segs.length) return <Text> </Text>;
  return (
    <Text wrap="truncate-end">
      {segs.map((s, i) => (
        <Text key={i} bold={s.bold} color={s.color} dimColor={s.dim}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

/**
 * A wrapped paragraph. `marker` ("• ", "1. ", "- ") goes before the first line and
 * the following lines hang under the text. Without `width` Ink wraps (no hanging).
 */
export function Para({ text, segs, width, marker = '', markerColor = 'gray', color, bold, dim }) {
  const base = { color, bold, dim };
  const parts = segs || parseInline(String(text ?? ''), base);
  if (!width) {
    return (
      <Text wrap="wrap">
        {marker ? <Text color={markerColor}>{marker}</Text> : null}
        {parts.map((s, i) => (
          <Text key={i} bold={s.bold} color={s.color} dimColor={s.dim}>
            {s.text}
          </Text>
        ))}
      </Text>
    );
  }
  const indent = stringWidth(marker);
  const lines = wrapSegments(parts, Math.max(8, width - indent));
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Box key={i}>
          {indent > 0 && (
            <Box width={indent} flexShrink={0}>
              <Text color={markerColor}>{i === 0 ? marker : ' '}</Text>
            </Box>
          )}
          <Segs segs={l} />
        </Box>
      ))}
    </Box>
  );
}

/** Minimal markdown: headings, bullets and numbered lists, fenced code, inline bold/code. */
export function RichText({ text, width }) {
  const out = [];
  let inCode = false;
  String(text || '')
    .split('\n')
    .forEach((line, i) => {
      if (/^\s*```/.test(line)) {
        inCode = !inCode;
        return;
      }
      if (inCode) {
        // Code keeps its indentation; long lines are cut into pieces, not word-wrapped.
        const pieces = width && stringWidth(line) > width ? hardSplit(line, width) : [line];
        pieces.forEach((p, k) =>
          out.push(
            <Text key={`${i}.${k}`} color="gray" wrap="truncate-end">
              {p || ' '}
            </Text>,
          ),
        );
        return;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        out.push(<Para key={i} text={h[2]} width={width} bold />);
        return;
      }
      const b = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (b) {
        const lead = ' '.repeat(Math.min(b[1].length, 8));
        const mark = /\d/.test(b[2]) ? `${b[2]} ` : '• ';
        out.push(<Para key={i} text={b[3]} width={width} marker={lead + mark} />);
        return;
      }
      out.push(line.trim() ? <Para key={i} text={line} width={width} /> : <Text key={i}> </Text>);
    });
  return <Box flexDirection="column">{out}</Box>;
}

/** "  ⎿  " followed by a block whose lines all hang under the first one. */
export function Tree({ children, color = 'gray' }) {
  return (
    <Box>
      <Box width={5} flexShrink={0}>
        <Text color={color}>{'  ⎿  '}</Text>
      </Box>
      <Box flexDirection="column" flexShrink={1} flexGrow={1}>
        {children}
      </Box>
    </Box>
  );
}
Tree.indent = 5;

/** "● " followed by a hanging block. */
export function Bullet({ color, children, marginTop = 1 }) {
  return (
    <Box marginTop={marginTop}>
      <Box width={2} flexShrink={0}>
        <Text color={color}>{BULLET}</Text>
      </Box>
      <Box flexDirection="column" flexShrink={1} flexGrow={1}>
        {children}
      </Box>
    </Box>
  );
}
Bullet.indent = 2;
