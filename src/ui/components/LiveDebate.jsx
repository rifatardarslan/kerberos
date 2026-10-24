import React from 'react';
import { Box, Text } from 'ink';
import { agentColor, wrapLine } from '../theme.js';

const KIND_STYLE = {
  thinking: { dimColor: true, italic: true },
  tool: { dimColor: true },
  error: { color: 'red' },
  system: { color: 'gray' },
};

/**
 * Live, colourised stream of agent output. `entries` are complete lines plus the
 * still-open line of each agent that is currently streaming (marked `open`).
 */
export function LiveDebate({ entries, height, width, scroll }) {
  const inner = Math.max(10, width - 4);
  const rows = [];
  for (const e of entries) {
    const tag = e.agent === '_sys' ? '' : `[${e.label}${e.kind === 'thinking' ? '·düşünce' : ''}] `;
    const wrapped = wrapLine(tag + e.text, inner);
    wrapped.forEach((line, i) => rows.push({ e, line, first: i === 0, tagLen: i === 0 ? tag.length : 0 }));
  }
  const visible = Math.max(1, height - 2);
  const end = Math.max(0, rows.length - scroll);
  const shown = rows.slice(Math.max(0, end - visible), end);

  return (
    <Box borderStyle="single" borderColor="gray" flexDirection="column" height={height} width={width} flexShrink={0} paddingX={1} overflow="hidden">
      {shown.length === 0 && <Text color="gray">Canlı tartışma burada akacak. Bir prompt yazıp Enter'a basın.</Text>}
      {shown.map((r, i) => {
        const style = KIND_STYLE[r.e.kind] || {};
        const color = r.e.agent === '_sys' ? (r.e.level === 'error' ? 'red' : r.e.level === 'warn' ? 'yellow' : 'gray') : agentColor(r.e.agent);
        return (
          <Text key={i} wrap="truncate-end">
            {r.tagLen > 0 && (
              <Text color={color} bold>
                {r.line.slice(0, r.tagLen)}
              </Text>
            )}
            <Text {...style} color={style.color || (r.e.agent === '_sys' ? color : undefined)}>
              {r.line.slice(r.tagLen)}
              {r.e.open && i === shown.length - 1 ? '▌' : ''}
            </Text>
          </Text>
        );
      })}
      {scroll > 0 && <Text color="yellow">↓ {scroll} satır daha (PgDn)</Text>}
    </Box>
  );
}
