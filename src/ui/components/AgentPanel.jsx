import React from 'react';
import { Box, Text } from 'ink';
import { BRAND, BULLET, FIRE, SPINNER, agentColor, fmtTokens, pickVerb } from '../theme.js';

const STEP = { draft: 'taslak', critique: 'eleştiri', revise: 'revizyon', synthesize: 'sentez', decompose: 'görev dağıtımı', repair: 'onarım', compact: 'bağlam özeti', triage: 'değerlendirme', reply: 'yanıt', solve: 'çözüm', answer: 'çözüm', final: 'sonuç' };
const STATUS_STEP = { BUILDING: 'code', DEBATING: 'draft' };

function lastLine(text, width) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const l = lines[lines.length - 1] || '';
  return l.length > width ? `${l.slice(0, width - 1)}…` : l;
}

function elapsedText(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Live area above the prompt, like Claude Code while it works: each running agent
 * call is an in-progress tool line with a blinking bullet and a preview of what it is
 * writing, and one spinner line sums the turn up ("✻ Kokluyor… (24s · ↓ 1.2k token)").
 */
export function LiveAgents({ live, frame, now, status, busy, width, turnStart, streamed = 0 }) {
  const entries = [...live.values()];
  if (!entries.length && !busy) return null;

  const glyph = SPINNER[frame % SPINNER.length];
  const shimmer = FIRE[frame % FIRE.length];
  const blink = Math.floor(frame / 5) % 2 === 0;
  const latest = entries.reduce((a, e) => (!a || e.startedAt > a.startedAt ? e : a), null);
  const verb = latest ? pickVerb(latest.step, latest.seed) : pickVerb(STATUS_STEP[status], 0);
  const since = turnStart || latest?.startedAt || now;
  const tokens = Math.round(streamed / 4);

  return (
    <Box flexDirection="column">
      {entries.map((e) => {
        const file = e.meta?.file;
        const preview = file || e.step === 'synthesize' || e.step === 'decompose' ? '' : lastLine(e.text, Math.max(20, width - 10));
        return (
          <Box key={`${e.agent}:${file || e.step}`} flexDirection="column" marginTop={1}>
            <Text wrap="truncate-end">
              <Text color={blink ? agentColor(e.agent) : 'gray'}>{BULLET} </Text>
              {file ? (
                <>
                  <Text bold>{e.meta.action === 'update_file' ? 'Update' : 'Write'}</Text>
                  <Text>({file})</Text>
                </>
              ) : (
                <>
                  <Text bold color={agentColor(e.agent)}>
                    {e.label}
                  </Text>
                  <Text>({STEP[e.step] || (e.role === 'chief' ? 'şef' : 'işçi')})</Text>
                </>
              )}
            </Text>
            <Text color="gray" wrap="truncate-end">
              {'  ⎿  '}
              {file ? `${e.label} yazıyor…` : preview || (e.thinking ? 'düşünüyor…' : 'çalışıyor…')}
            </Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text wrap="truncate-end">
          <Text color={BRAND}>{glyph} </Text>
          <Text color={shimmer}>{verb}…</Text>
          <Text color="gray">{` (${elapsedText(now - since)}${tokens ? ` · ↓ ${fmtTokens(tokens)} token` : ''})`}</Text>
        </Text>
      </Box>
    </Box>
  );
}
