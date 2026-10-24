import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { agentColor } from '../theme.js';

function StatusIcon({ status }) {
  switch (status) {
    case 'busy':
      return (
        <Text color="yellow">
          <Spinner type="dots" />
        </Text>
      );
    case 'cooldown':
      return <Text color="yellow">⏸</Text>;
    case 'unavailable':
      return <Text color="red">✖</Text>;
    default:
      return <Text color="green">●</Text>;
  }
}

/**
 * Agent bar. In settings mode (Tab) the selected agent is highlighted and can be
 * promoted to chief or have its model / effort cycled.
 */
export function AgentPanel({ order, state, settings, selected }) {
  return (
    <Box flexDirection="column">
      <Box flexWrap="wrap" columnGap={1}>
        {order.map((id, i) => {
          const a = state.agents[id] || {};
          const isChief = id === state.chief;
          const isSel = settings && i === selected;
          return (
            <Box
              key={id}
              borderStyle={isSel ? 'double' : 'single'}
              borderColor={isSel ? 'white' : isChief ? agentColor(id) : 'gray'}
              paddingX={1}
              flexDirection="column"
            >
              <Box gap={1}>
                <StatusIcon status={a.status} />
                <Text bold color={agentColor(id)}>
                  {a.label || id}
                </Text>
                <Text color={isChief ? 'yellow' : 'gray'}>{isChief ? '★ ŞEF' : 'işçi'}</Text>
              </Box>
              <Text color="gray">
                {a.model || 'varsayılan'}
                {a.effort ? ` · ${a.effort}` : ''}
                {a.variant ? ` · #${a.variant}` : ''}
                {a.note ? ` · ${a.note}` : ''}
              </Text>
            </Box>
          );
        })}
      </Box>
      {settings && (
        <Text color="white">
          <Text bold>AYARLAR </Text>
          <Text color="gray">←/→ ajan seç · </Text>
          <Text color="yellow">S</Text>
          <Text color="gray"> şef yap · </Text>
          <Text color="yellow">M</Text>
          <Text color="gray"> model · </Text>
          <Text color="yellow">E</Text>
          <Text color="gray"> effort · </Text>
          <Text color="yellow">Tab/Esc</Text>
          <Text color="gray"> kapat</Text>
        </Text>
      )}
    </Box>
  );
}
