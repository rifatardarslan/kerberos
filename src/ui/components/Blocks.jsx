import React from 'react';
import { Box, Text } from 'ink';
import { BULLET, SUGGEST } from '../theme.js';

// Building blocks shared by the transcript entries: Claude Code's "●" and "⎿" layout
// and a small Markdown renderer.

/** **bold** and `code` inline formatting. */
function Inline({ text }) {
  const parts = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(<Text key={last}>{text.slice(last, m.index)}</Text>);
    const tok = m[0];
    parts.push(
      tok.startsWith('**') ? (
        <Text key={m.index} bold>
          {tok.slice(2, -2)}
        </Text>
      ) : (
        <Text key={m.index} color={SUGGEST}>
          {tok.slice(1, -1)}
        </Text>
      ),
    );
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(<Text key={last}>{text.slice(last)}</Text>);
  return <>{parts}</>;
}

/** Minimal markdown: headings, bullets, fenced code, inline bold/code. */
export function RichText({ text }) {
  const out = [];
  let inCode = false;
  text.split('\n').forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      return;
    }
    if (inCode) {
      out.push(
        <Text key={i} color="gray">
          {line || ' '}
        </Text>,
      );
      return;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push(
        <Text key={i} bold>
          <Inline text={h[2]} />
        </Text>,
      );
      return;
    }
    const b = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (b) {
      out.push(
        <Text key={i} wrap="wrap">
          {b[1]}
          <Text color="gray">• </Text>
          <Inline text={b[2]} />
        </Text>,
      );
      return;
    }
    out.push(
      <Text key={i} wrap="wrap">
        {line ? <Inline text={line} /> : ' '}
      </Text>,
    );
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
