import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { SUGGEST } from '../theme.js';

/**
 * Numbered choice box in the style of Claude Code's permission prompt:
 *   ❯ 1. Evet
 *     2. Hayır
 * ↑↓ / number keys to move, Enter to pick, Esc to dismiss.
 */
export function SelectMenu({ title, subtitle, options, onSelect, onCancel, color = SUGGEST, initial, isActive = true, maxVisible = 10, footer }) {
  const enabled = options.map((o, i) => (o.disabled ? null : i)).filter((i) => i !== null);
  const first = initial ?? Math.max(0, options.findIndex((o) => o.current && !o.disabled));
  const [index, setIndex] = useState(enabled.includes(first) ? first : enabled[0] ?? 0);
  const start = Math.max(0, Math.min(index - Math.floor(maxVisible / 2), options.length - maxVisible));

  useInput(
    (input, key) => {
      if (key.escape) return onCancel?.();
      if (key.upArrow || (key.shift && key.tab)) {
        const pos = enabled.indexOf(index);
        return setIndex(enabled[(pos - 1 + enabled.length) % enabled.length]);
      }
      if (key.downArrow || key.tab) {
        const pos = enabled.indexOf(index);
        return setIndex(enabled[(pos + 1) % enabled.length]);
      }
      if (key.return) return onSelect?.(options[index], index);
      const n = Number(input);
      if (n >= 1 && n <= options.length && !options[n - 1].disabled) {
        setIndex(n - 1);
        onSelect?.(options[n - 1], n - 1);
      }
    },
    { isActive },
  );

  return (
    <Box borderStyle="round" borderColor={color} flexDirection="column" paddingX={2} marginTop={1}>
      <Text bold color={color}>
        {title}
      </Text>
      {subtitle && (
        <Text color="gray" wrap="wrap">
          {subtitle}
        </Text>
      )}
      <Text> </Text>
      {start > 0 && <Text color="gray">{`  ↑ ${start} seçenek daha`}</Text>}
      {options.slice(start, start + maxVisible).map((o, k) => {
        const i = start + k;
        const sel = i === index;
        return (
          <Text key={i} wrap="truncate-end" color={o.disabled ? 'gray' : undefined} dimColor={o.disabled}>
            <Text color={sel ? color : 'gray'}>{sel ? '❯ ' : '  '}</Text>
            <Text color={sel ? color : undefined} bold={sel}>
              {i + 1}. {o.label}
            </Text>
            {o.current && <Text color="green"> ✓</Text>}
            {o.hint && <Text color="gray"> {o.hint}</Text>}
          </Text>
        );
      })}
      {start + maxVisible < options.length && <Text color="gray">{`  ↓ ${options.length - start - maxVisible} seçenek daha`}</Text>}
      <Text> </Text>
      <Text color="gray">{footer || '↑↓ seç · enter onayla · esc kapat'}</Text>
    </Box>
  );
}
