import React from 'react';
import { Box, Text } from 'ink';
import { t } from '../../i18n/index.js';
import { MODE_INFO, SUGGEST } from '../theme.js';

export { PromptInput } from './PromptInput.jsx';

/** Windowed suggestion list under the prompt (slash commands, @files). */
function Suggestions({ rows, selected, max = 8, empty }) {
  if (!rows.length) {
    return empty ? (
      <Box paddingX={2}>
        <Text color="gray">{empty}</Text>
      </Box>
    ) : null;
  }
  const start = Math.max(0, Math.min(selected - Math.floor(max / 2), rows.length - max));
  const shown = rows.slice(start, start + max);
  const pad = Math.min(40, Math.max(...rows.map((r) => r.key.length)) + 3);
  return (
    <Box flexDirection="column" paddingX={2}>
      {shown.map((r, i) => {
        const sel = start + i === selected;
        return (
          <Text key={r.key} wrap="truncate-end" color={sel ? SUGGEST : 'gray'}>
            {r.key.padEnd(pad)}
            {r.desc || ''}
          </Text>
        );
      })}
      {rows.length > max && <Text color="gray">{`… ${rows.length - max} daha`}</Text>}
    </Box>
  );
}

export function SlashMenu({ items, selected }) {
  return <Suggestions rows={items.map((c) => ({ key: `/${c.name}${c.args ? ` ${c.args}` : ''}`, desc: c.desc }))} selected={selected} empty={t('No matching command')} />;
}

export function FileMenu({ files, selected }) {
  return <Suggestions rows={files.map((f) => ({ key: `@${f}` }))} selected={selected} empty={t('No matching file')} />;
}

const SHORTCUTS = [
  ['/', 'commands'],
  ['@', 'attach a file'],
  ['shift+tab', 'switch mode'],
  ['ctrl+r', 'search history'],
  ['ctrl+o', 'expand the last output'],
  ['\\ + enter', 'new line'],
];

/** `?` panel, replaces the footer until dismissed. */
export function Shortcuts() {
  return (
    <Box paddingX={2} flexWrap="wrap" columnGap={4}>
      {SHORTCUTS.map(([k, d]) => (
        <Text key={k} color="gray">
          {k} {t(d)}
        </Text>
      ))}
    </Box>
  );
}

const MSG_COLOR = { error: 'red', warn: 'yellow', ok: 'green', info: 'gray' };
const RC_LOOK = { on: ['green', '● RC'], connecting: ['yellow', '… RC'], error: ['red', '✖ RC'] };

/**
 * The line under the prompt, like Claude Code's: hints or the permission mode on the
 * left (always visible, so shift+tab shows its effect at once), notifications on the
 * right.
 */
export function Footer({ state, rc, message, ctrlCArmed, inputMode, queued = 0, width }) {
  const mode = MODE_INFO[state.permissionMode];
  let left;
  if (ctrlCArmed) left = <Text color="gray">{t('Press ctrl+c again to exit')}</Text>;
  else if (inputMode === 'feedback') left = <Text color="magenta">{t('writing feedback on the plan')}</Text>;
  else if (inputMode === 'model') left = <Text color="magenta">{t('type the model name')}</Text>;
  else {
    const parts = [];
    if (mode?.footer) parts.push(<Text key="m" color={mode.color}>{`${mode.footer} (${t('shift+tab to cycle')})`}</Text>);
    if (queued) parts.push(<Text key="q" color="yellow">{`${queued} mesaj kuyrukta`}</Text>);
    if (!parts.length) parts.push(<Text key="k" color="gray">{t('? for shortcuts')}</Text>);
    left = (
      <Text wrap="truncate-end">
        {parts.map((p, i) => (
          <React.Fragment key={i}>
            {i > 0 && <Text color="gray"> · </Text>}
            {p}
          </React.Fragment>
        ))}
      </Text>
    );
  }
  const look = RC_LOOK[rc];
  return (
    <Box paddingX={2} justifyContent="space-between" width={width} columnGap={2}>
      <Box flexShrink={0}>{left}</Box>
      <Box flexShrink={1} overflow="hidden" columnGap={2}>
        {message && (
          <Text color={MSG_COLOR[message.level] || 'gray'} wrap="truncate-end">
            {message.text}
          </Text>
        )}
        {look && (
          <Box flexShrink={0}>
            <Text color={look[0]}>{look[1]}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
