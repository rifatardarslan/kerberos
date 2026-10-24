import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { STATUS_COLORS, STATUS_LABELS, agentColor } from '../theme.js';

export function Header({ root, state, telegram, width }) {
  const busy = state.status === 'DEBATING' || state.status === 'BUILDING';
  const chiefLabel = state.agents[state.chief]?.label || state.chief;
  const maxPath = Math.max(12, width - 70);
  const shownRoot = root.length > maxPath ? '…' + root.slice(-maxPath + 1) : root;

  return (
    <Box borderStyle="round" borderColor="red" paddingX={1} justifyContent="space-between">
      <Box>
        <Text bold color="red">KERBEROS </Text>
        <Text color="gray">▸ </Text>
        <Text>{shownRoot}</Text>
      </Box>
      <Box gap={2}>
        <Text bold color={state.mode === 'CODING' ? 'cyan' : 'yellow'}>[{state.mode}]</Text>
        <Text color={STATUS_COLORS[state.status]}>
          {busy ? <Spinner type="dots" /> : '●'} {STATUS_LABELS[state.status]}
        </Text>
        <Text>
          <Text color="gray">şef </Text>
          <Text color={agentColor(state.chief)}>{chiefLabel}</Text>
        </Text>
        <Text color={telegram === 'on' ? 'green' : telegram === 'error' ? 'red' : 'gray'}>tg {telegram === 'on' ? '●' : '○'}</Text>
      </Box>
    </Box>
  );
}
