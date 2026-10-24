import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

const HINTS = {
  IDLE: [['Enter', 'planla']],
  DEBATING: [['X', 'durdur']],
  AWAITING_APPROVAL: [
    ['C', 'kodu yazdır'],
    ['P', 'yeniden planla'],
    ['X', 'iptal'],
  ],
  BUILDING: [['X', 'durdur']],
  DONE: [
    ['U', 'geri al'],
    ['A', 'kabul et'],
  ],
  ABORTED: [['U', 'geri al']],
  ERROR: [['U', 'geri al']],
};

function Hint({ k, label }) {
  return (
    <Text>
      <Text color="yellow" bold>
        {k}
      </Text>
      <Text color="gray"> {label}</Text>
    </Text>
  );
}

/**
 * Two focus modes so single-key shortcuts never collide with typing:
 *  - input:   typing a prompt, Enter sends, Esc -> command mode
 *  - command: P/C/X/U/A/Q shortcuts, Enter or I -> input mode
 */
export function CommandInput({ mode, value, onChange, onSubmit, status, canRollback, emptyPlan, message, placeholder }) {
  const typing = mode === 'input';
  const hints = (HINTS[status] || [])
    .filter(([k]) => k !== 'U' || canRollback)
    .map(([k, l]) => (k === 'C' && emptyPlan ? [k, 'kapat (değişiklik yok)'] : [k, l]));

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={typing ? 'cyan' : 'gray'} paddingX={1}>
        <Text color={typing ? 'cyan' : 'gray'}>{typing ? '❯ ' : '⌘ '}</Text>
        {typing ? (
          <TextInput value={value} onChange={onChange} onSubmit={onSubmit} placeholder={placeholder} />
        ) : (
          <Text color="gray">komut modu: kısayollar aktif · yazmak için Enter / I</Text>
        )}
      </Box>
      <Box justifyContent="space-between" paddingX={1} gap={2}>
        <Box gap={2} flexShrink={0}>
          {!typing && hints.map(([k, l]) => <Hint key={k} k={k} label={l} />)}
          {typing && <Hint k="Esc" label="kısayollar" />}
          <Hint k="Tab" label="ajan ayarları" />
          {!typing && <Hint k="R" label="RC aç/kapat" />}
          {!typing && <Hint k="PgUp/PgDn" label="kaydır" />}
          {!typing && <Hint k="Q" label="çıkış" />}
        </Box>
        {message && (
          <Box flexShrink={1} overflow="hidden">
            <Text color={message.level === 'error' ? 'red' : message.level === 'warn' ? 'yellow' : 'green'} wrap="truncate-end">
              {message.text}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
