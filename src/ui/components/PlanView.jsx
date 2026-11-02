import path from 'node:path';
import React from 'react';
import { Box, Text } from 'ink';
import { BRAND, BULLET, PLAN, agentColor, localized } from '../theme.js';
import { Bullet, Para, RichText, Tree } from './Blocks.jsx';
import { t, tn } from '../../i18n/index.js';

/** A titled list; `numbered` lists drop the numbers agents often write themselves. */
function Section({ title, items, color, width, numbered = false }) {
  if (!items?.length) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{title}</Text>
      {items.map((it, i) => {
        const text = String(typeof it === 'string' ? it : it?.question || '');
        return numbered ? (
          <Para key={i} text={text.replace(/^\s*\d+[.)]\s*/, '')} width={width} marker={`  ${i + 1}. `} markerColor={color || 'gray'} />
        ) : (
          <Para key={i} text={text} width={width} marker="  - " markerColor={color || 'gray'} />
        );
      })}
    </Box>
  );
}

/** Consensus plan, shown like Claude Code's plan-mode box. */
export function PlanCard({ plan, width }) {
  const files = plan.files_to_modify || [];
  const box = Math.min(width - 2, 110);
  const inner = box - 4; // border + padding
  return (
    <Box flexDirection="column">
      <Bullet color={PLAN}>
        <Text>
          <Text bold>{t('Plan ready')}</Text>
          <Text color="gray">{` · ${files.length ? tn(files.length, '{n} file', '{n} files') : t('no file changes')}`}</Text>
        </Text>
      </Bullet>
      <Box borderStyle="round" borderColor={PLAN} flexDirection="column" paddingX={1} marginLeft={2} width={box}>
        <RichText text={plan.summary || ''} width={inner} />
        <Section title={t('Questions')} items={plan.questions} color="yellow" width={inner} />
        <Section title={t('Files')} items={files} color={PLAN} width={inner} />
        <Section title={t('Dependencies')} items={plan.dependencies} width={inner} />
        <Section title={t('Risks')} items={plan.risks} color="red" width={inner} />
        <Section title={t('Steps')} items={plan.steps} width={inner} numbered />
      </Box>
    </Box>
  );
}

const STATUS_STYLE = localized({
  A: { color: 'green', label: 'new' },
  M: { color: 'yellow', label: 'changed' },
  D: { color: 'red', label: 'deleted' },
  R: { color: 'cyan', label: 'moved' },
});

/** Summary after a build: files with +/- counts. */
export function DiffCard({ diff, tasks = [], error, review, preview }) {
  const files = diff?.files || [];
  const added = files.reduce((n, f) => n + (f.added || 0), 0);
  const removed = files.reduce((n, f) => n + (f.removed || 0), 0);
  const failed = tasks.filter((t) => t.status === 'failed');
  const pad = Math.min(48, Math.max(8, ...files.map((f) => f.path.length)));

  return (
    <Box flexDirection="column">
      <Bullet color={error ? 'yellow' : 'green'}>
        <Text>
          <Text bold>{error ? t('Coding partly done') : t('Coding done')}</Text>
          <Text color="gray">{` · ${tn(files.length, '{n} file', '{n} files')} · `}</Text>
          <Text color="green">+{added}</Text>
          <Text color="gray"> </Text>
          <Text color="red">−{removed}</Text>
        </Text>
      </Bullet>
      <Tree>
        {files.length === 0 && <Text color="gray">{t('no changes')}</Text>}
        {files.map((f) => {
          const st = STATUS_STYLE[f.status] || { color: 'white', label: f.status };
          return (
            <Text key={f.path} wrap="truncate-end">
              <Text color={st.color}>{f.status} </Text>
              <Text>{f.path.padEnd(pad)} </Text>
              {f.added > 0 && <Text color="green">+{f.added} </Text>}
              {f.removed > 0 && <Text color="red">−{f.removed} </Text>}
              <Text color="gray">{st.label}</Text>
            </Text>
          );
        })}
        {failed.map((task) => (
          <Text key={task.file_path} color="red">
            {t('{path} could not be written', { path: task.file_path })}
          </Text>
        ))}
        {review?.rounds > 0 && (
          <Text color="gray">
            {review.findings ? t('cross review: {n} findings, {files} improved', { n: review.findings, files: tn(review.fixed.length, '{n} file', '{n} files') }) : t('cross review: no problems found')}
          </Text>
        )}
        {preview && (
          <Text color="gray">
            {`${t('site check')}: ${preview.problems ? tn(preview.problems, '{n} problem left', '{n} problems left') : t('no automatic problems')} · ${tn(preview.shots.length, '{n} screenshot', '{n} screenshots')}${preview.dir ? ` · ${preview.dir}/` : ''}`}
          </Text>
        )}
        {files.length > 0 && <Text color="gray">{t('/undo reverts it')}</Text>}
      </Tree>
    </Box>
  );
}

/** Unified diff with +/- colouring (for /diff). */
export function DiffText({ text }) {
  const lines = text.split('\n');
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={BRAND}>{BULLET} </Text>
        <Text bold>Diff</Text>
      </Text>
      {lines.map((l, i) => {
        let color;
        let bold = false;
        if (l.startsWith('diff --git')) bold = true;
        else if (l.startsWith('+++') || l.startsWith('---')) color = 'gray';
        else if (l.startsWith('+')) color = 'green';
        else if (l.startsWith('-')) color = 'red';
        else if (l.startsWith('@@')) color = 'cyan';
        else if (/^(index|new file|deleted file)/.test(l)) color = 'gray';
        return (
          <Text key={i} color={color} bold={bold} wrap="truncate-end">
            {'  '}
            {l || ' '}
          </Text>
        );
      })}
    </Box>
  );
}

/** Review findings under a phase line: "[high] file · issue (by Codex)". */
export function Findings({ findings = [], width, max = 8 }) {
  const color = { high: 'red', medium: 'yellow', low: 'gray' };
  return (
    <Box flexDirection="column">
      {findings.slice(0, max).map((f, i) => (
        <Para key={i} text={`${f.file} · ${f.issue} (${f.by})`} width={width} marker={`     ${t(f.severity)} `} markerColor={color[f.severity]} />
      ))}
      {findings.length > max && <Text color="gray">{`  ${t('… and {n} more', { n: findings.length - max })}`}</Text>}
    </Box>
  );
}

/** The site check: what KERBEROS saw in the browser, and where the screenshots are. */
export function PreviewCard({ report, root, final, width }) {
  const problems = report.pages.flatMap((p) => p.problems.map((x) => `[${p.viewport === 'mobile' ? t('phone') : t('desktop')} ${p.path}] ${x}`));
  const rel = (f) => (root ? path.relative(root, f).split(path.sep).join('/') : f);
  const clicked = report.pages.reduce((n, p) => n + (p.clicked?.length || 0), 0);
  const views = report.pages.length;
  return (
    <Box flexDirection="column">
      <Bullet color={problems.length ? 'yellow' : 'green'}>
        <Text>
          <Text bold>{final ? t('Site after the fixes') : t('Site opened in the browser')}</Text>
          <Text color="gray">{` · ${report.url} · ${tn(views, '{n} page view', '{n} page views')}${clicked ? ` · ${tn(clicked, '{n} button clicked', '{n} buttons clicked')}` : ''}`}</Text>
        </Text>
      </Bullet>
      <Tree>
        {problems.length === 0 && <Text color="green">{t('no JS errors, failed requests, dead buttons or overflow')}</Text>}
        {problems.slice(0, 10).map((p, i) => (
          <Para key={i} text={p} width={width - 6} marker="- " markerColor="yellow" />
        ))}
        {problems.length > 10 && <Text color="gray">{t('… and {n} more', { n: problems.length - 10 })}</Text>}
        <Text color="gray" wrap="truncate-end">{`${t('screenshots')}: ${rel(path.dirname(report.shots[0]?.file || '.'))}/ (${report.shots.map((s) => path.basename(s.file)).join(', ')})`}</Text>
      </Tree>
    </Box>
  );
}

/** One task line in the transcript: ● Write(path) / ● Update(path). */
export function TaskLine({ task }) {
  const ok = task.status === 'done';
  const verb = task.action === 'fix' ? 'Improve' : task.existed || task.action === 'update_file' ? 'Update' : 'Write';
  const who = task.worker || task.target_worker;
  return (
    <Box flexDirection="column">
      <Bullet color={ok ? 'green' : 'red'} marginTop={0}>
        <Text wrap="truncate-end">
          <Text bold>{verb}</Text>
          <Text>({task.file_path})</Text>
        </Text>
      </Bullet>
      <Tree>
        <Text>
          {ok ? (
            <Text>
              <Text bold>{task.lines ?? '?'}</Text>
              <Text color="gray">{` ${t('lines written')}${task.findings ? ` · ${tn(task.findings, '{n} finding', '{n} findings')}` : ''} · `}</Text>
            </Text>
          ) : (
            <Text color="red">{`${t('not written')} · `}</Text>
          )}
          <Text color={agentColor(who)}>{task.workerLabel || who}</Text>
        </Text>
      </Tree>
    </Box>
  );
}
