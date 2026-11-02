import React from 'react';
import os from 'node:os';
import { Box, Text } from 'ink';
import { BRAND, EYE, FIRE, HOUND, agentColor, relTime, shortPath } from '../theme.js';
import { t } from '../../i18n/index.js';

/** The hound, coloured line by line in underworld fire with glowing eyes. */
function Hound() {
  return (
    <Box flexDirection="column">
      {HOUND.map((line, i) => (
        <Text key={i} color={FIRE[i % FIRE.length]}>
          {line.split('◉').map((part, j, arr) => (
            <React.Fragment key={j}>
              {part}
              {j < arr.length - 1 && (
                <Text color={EYE} bold>
                  ◉
                </Text>
              )}
            </React.Fragment>
          ))}
        </Text>
      ))}
    </Box>
  );
}

function userName() {
  try {
    const n = os.userInfo().username || '';
    return n ? n[0].toLocaleUpperCase('tr-TR') + n.slice(1) : '';
  } catch {
    return '';
  }
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);

/**
 * Welcome box printed once at the top of the transcript, laid out like Claude Code's:
 * name and version in the top border, greeting / mascot / model / folder on the
 * left, tips and recent sessions on the right.
 */
export function Banner({ version, root, state, width, chiefModel, recent = [] }) {
  const W = Math.max(40, Math.min(width, 120));
  const twoCols = W >= 76;
  const inner = W - 4; // borders + padding
  const leftW = twoCols ? Math.floor(inner * 0.52) : inner;
  const rightW = inner - leftW - 3;
  const chief = state.agents[state.chief];
  const workers = state.workers.filter((w) => state.agents[w]?.status !== 'unavailable');
  const missing = Object.entries(state.agents).filter(([, a]) => a.status === 'unavailable').map(([id]) => id);
  const name = userName();

  const title = ' Kerberos ';
  const ver = `v${version} `;
  const rule = Math.max(0, W - 2 - 3 - title.length - ver.length);

  return (
    <Box flexDirection="column" width={W}>
      <Text>
        <Text color={BRAND}>╭───</Text>
        <Text color={BRAND} bold>
          {title}
        </Text>
        <Text color="gray">{ver}</Text>
        <Text color={BRAND}>{`${'─'.repeat(rule)}╮`}</Text>
      </Text>
      <Box borderStyle="round" borderTop={false} borderColor={BRAND} paddingX={1} width={W}>
        <Box flexDirection="column" alignItems="center" width={leftW} paddingY={1}>
          <Text bold>{name ? t(recent.length ? 'Welcome back, {name}!' : 'Welcome, {name}!', { name }) : t(recent.length ? 'Welcome back!' : 'Welcome!')}</Text>
          {leftW >= 31 ? (
            <Box marginY={1}>
              <Hound />
            </Box>
          ) : (
            <Text> </Text>
          )}
          <Text color="gray" wrap="truncate-end">
            {clip(`${chiefModel ? `${chiefModel} · ` : ''}${t('chief')} ${chief?.label || state.chief}`, leftW)}
          </Text>
          {workers.length > 0 && (
            <Text wrap="truncate-end">
              {workers.map((w, i) => (
                <React.Fragment key={w}>
                  {i > 0 && <Text color="gray"> · </Text>}
                  <Text color={agentColor(w)}>{state.agents[w]?.label || w}</Text>
                </React.Fragment>
              ))}
            </Text>
          )}
          <Text color="gray">{shortPath(root, leftW)}</Text>
        </Box>
        {twoCols && (
          <Box borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} borderColor={BRAND} paddingLeft={1} marginLeft={1} flexDirection="column" width={rightW + 2}>
            <Text color={BRAND} bold>
              {t('Getting started')}
            </Text>
            <Text wrap="truncate-end">{clip(t('Type a task or a question; the chief decides'), rightW)}</Text>
            <Text wrap="truncate-end">{clip(t('@ attaches files, /help lists commands'), rightW)}</Text>
            <Text color={BRAND} dimColor>
              {'─'.repeat(Math.max(0, rightW))}
            </Text>
            <Text color={BRAND} bold>
              {t('Recent activity')}
            </Text>
            {recent.length ? (
              recent.slice(0, 3).map((r) => (
                <Text key={r.id} wrap="truncate-end">
                  <Text color="gray">{relTime(r.updatedAt).padEnd(11)}</Text>
                  {clip(r.title || t('(untitled)'), rightW - 11)}
                </Text>
              ))
            ) : (
              <Text color="gray">{t('No activity yet')}</Text>
            )}
            {missing.length > 0 && <Text color="yellow">{clip(`${t('Not found')}: ${missing.join(', ')}`, rightW)}</Text>}
          </Box>
        )}
      </Box>
    </Box>
  );
}
