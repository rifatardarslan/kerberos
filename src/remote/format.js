// Telegram message layout: HTML cards for plans, results, progress and status, and a
// small Markdown → Telegram-HTML converter for agent answers. Pure functions only.

import { localized, t, tn } from '../i18n/index.js';

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const STATUS_TEXT = localized({ IDLE: 'ready', DEBATING: 'thinking', AWAITING_ANSWERS: 'waiting for answers', AWAITING_APPROVAL: 'waiting for approval', BUILDING: 'coding', DONE: 'done', ABORTED: 'stopped', ERROR: 'error' });
export const MODE_TEXT = localized({ default: 'ask', auto: 'auto', plan: 'plan only' });
export const MODE_HINT = localized({ default: 'plans need approval', auto: 'plans are coded without approval', plan: 'no code is written' });
export const SOURCE_TEXT = localized({ tui: 'TUI', telegram: 'Telegram', auto: 'auto mode', system: 'system' });
const FILE_ICON = { A: '🟢', M: '🟡', D: '🔴', R: '🔵' };

const MAX = 3900;
const short = (s, n) => {
  const str = String(s || '').replace(/\s+/g, ' ').trim();
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};
const join = (lines) => lines.filter((l) => l !== null && l !== undefined && l !== false).join('\n');

export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? t('{n} s', { n: s }) : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ markdown

/**
 * Agents answer in Markdown; Telegram speaks a small HTML subset. Handles fenced and
 * inline code, headings, bold/italic/strike, links, bullets, quotes and tables (as
 * monospace). Everything else is escaped text.
 */
export function mdToHtml(md) {
  const blocks = [];
  const keep = (html) => `\u0000${blocks.push(html) - 1}\u0000`;
  let s = String(md || '').replace(/\r\n/g, '\n');

  s = s.replace(/```([\w+-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g, (_, lang, code) => keep(`<pre><code${lang ? ` class="language-${esc(lang)}"` : ''}>${esc(code.replace(/\n$/, ''))}</code></pre>`));
  // Tables read badly in a proportional font: keep them monospace.
  s = s.replace(/(?:^\|.*\|[ \t]*(?:\n|$))+/gm, (t) => keep(`<pre>${esc(t.replace(/\n$/, ''))}</pre>\n`));
  s = s.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${esc(code)}</code>`));

  s = esc(s);
  s = s.replace(/^#{1,6}\s+(.+?)\s*#*$/gm, '<b>$1</b>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/__(.+?)__/g, '<b>$1</b>');
  s = s.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1<i>$2</i>');
  s = s.replace(/~~(.+?)~~/g, '<s>$1</s>');
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => `<a href="${u.replace(/"/g, '&quot;')}">${t}</a>`);
  s = s.replace(/^(\s*)[-*+]\s+/gm, '$1• ');
  s = s.replace(/^-{3,}$/gm, '──────────');
  s = s.replace(/(?:^&gt; ?.*(?:\n|$))+/gm, (q) => `<blockquote>${q.replace(/^&gt; ?/gm, '').replace(/\n$/, '')}</blockquote>\n`);
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]).trim();
}

/**
 * Split Markdown into pieces that each fit one message after conversion, at blank
 * lines where possible; a code fence cut in two is closed and reopened.
 */
export function splitMarkdown(md, n = 3300) {
  const parts = [];
  let rest = String(md || '').trim();
  let reopen = '';
  while (rest.length > n) {
    let at = rest.lastIndexOf('\n\n', n);
    if (at < n / 2) at = rest.lastIndexOf('\n', n);
    if (at < n / 2) at = n;
    let part = reopen + rest.slice(0, at);
    rest = rest.slice(at).replace(/^\n+/, '');
    const fences = part.match(/^```.*$/gm) || [];
    reopen = '';
    if (fences.length % 2) {
      reopen = `${fences.at(-1)}\n`;
      part += '\n```';
    }
    parts.push(part);
  }
  if (rest) parts.push(reopen + rest);
  return parts;
}

// ------------------------------------------------------------------ cards

const prompted = (prompt, source) => (prompt ? `<blockquote>${source === 'tui' ? '🖥 ' : ''}${esc(short(prompt, 300))}</blockquote>` : null);

export function planCard(plan, prompt, source) {
  const files = plan.files_to_modify || [];
  const extra = join([
    plan.dependencies?.length ? `📦 <b>${t('Dependencies')}</b>\n${plan.dependencies.map((d) => `• ${esc(d)}`).join('\n')}` : null,
    plan.risks?.length ? `⚠️ <b>${t('Risks')}</b>\n${plan.risks.map((r) => `• ${esc(r)}`).join('\n')}` : null,
    plan.steps?.length ? `🪜 <b>${t('Steps')}</b>\n${plan.steps.map((st, i) => `${i + 1}. ${esc(st)}`).join('\n')}` : null,
  ]);
  const text = join([
    `📋 <b>${t('Plan ready')}</b>${files.length ? ` · ${tn(files.length, '{n} file', '{n} files')}` : ''}`,
    prompted(prompt, source),
    '',
    mdToHtml(plan.summary),
    files.length ? `\n📄 <b>${t('Files')}</b>\n${files.map((f) => `<code>${esc(f)}</code>`).join('\n')}` : `\nℹ️ ${t('No file changes.')}`,
    plan.questions?.length ? `\n❓ <b>${t("Chief's questions")}</b>\n${plan.questions.map((q) => `• ${esc(q)}`).join('\n')}` : null,
    extra ? `\n<blockquote expandable>${extra}</blockquote>` : null,
    afterLine(plan.after),
    `\n<i>${t(plan.questions?.length ? 'Write your answer and the plan is redone with it.' : 'To change something, just write it.')}</i>`,
  ]);
  return text.length > MAX ? `${text.slice(0, MAX - 20)}…` : text;
}

/** "🔎 Then: cross review · site check (npm install + dev server)" for the plan card. */
function afterLine(after) {
  if (!after || (!after.review && !after.site)) return null;
  const parts = [after.review ? t('cross review') : null, after.site === 'npm' ? t('site check (npm install + dev server)') : after.site ? t('site check in a browser') : null];
  return `\n🔎 ${t('Then')}: ${parts.filter(Boolean).join(' · ')}`;
}

/** One of the chief's clarifying questions; the options are the buttons below it. */
export function questionCard({ questions, answers = [], index, prompt, source }) {
  const q = questions[index];
  const done = questions.map((x, i) => (answers[i] != null ? `☑️ ${esc(x.header || t('Question {n}', { n: i + 1 }))}: <i>${esc([].concat(answers[i]).join(', '))}</i>` : null)).filter(Boolean);
  const text = join([
    `❓ <b>${t("Chief's question")}</b>${questions.length > 1 ? ` · ${index + 1}/${questions.length}` : ''}`,
    prompted(prompt, source),
    done.length ? done.join('\n') : null,
    '',
    `<b>${esc(q.question)}</b>`,
    q.options.some((o) => o.description) ? q.options.map((o) => `• <b>${esc(o.label)}</b>${o.description ? ` · ${esc(o.description)}` : ''}`).join('\n') : null,
    `\n<i>${t(q.multiSelect ? 'Pick several and press ✅ Done, or write your answer.' : 'Pick an option or write your answer.')}</i>`,
  ]);
  return text.length > MAX ? `${text.slice(0, MAX - 20)}…` : text;
}

/** The questions with the user's answers, once all are answered. */
export function answersCard(questions, answers) {
  return join([`❓ <b>${t('Questions answered')}</b>`, ...questions.map((q, i) => `• ${esc(q.question)}\n  → <b>${esc([].concat(answers[i] ?? '').join(', '))}</b>`)]);
}

export function doneCard(diff, tasks = [], error, { review, preview } = {}) {
  const files = diff?.files || [];
  const added = files.reduce((n, f) => n + (f.added || 0), 0);
  const removed = files.reduce((n, f) => n + (f.removed || 0), 0);
  const failed = tasks.filter((task) => task.status === 'failed');
  const rows = files.slice(0, 30).map((f) => {
    const nums = [f.added ? `+${f.added}` : null, f.removed ? `−${f.removed}` : null].filter(Boolean).join(' ');
    return `${FILE_ICON[f.status] || '⚪'} <code>${esc(f.path)}</code>${nums ? ` <i>${nums}</i>` : ''}`;
  });
  return join([
    `${error ? `⚠️ <b>${t('Partly coded')}</b>` : `✅ <b>${t('Coded')}</b>`} · ${tn(files.length, '{n} file', '{n} files')}${added || removed ? ` · +${added} −${removed}` : ''}`,
    '',
    rows.length ? rows.join('\n') : t('No changes.'),
    files.length > 30 ? `<i>${tn(files.length - 30, '… and {n} more file', '… and {n} more files')}</i>` : null,
    failed.length ? `\n❌ <b>${t('Not written')}</b>: ${failed.map((task) => `<code>${esc(task.file_path)}</code>`).join(', ')}` : null,
    review?.rounds ? `\n🔎 ${review.findings ? t('cross review: {n} findings, {files} improved', { n: review.findings, files: tn(review.fixed.length, '{n} file', '{n} files') }) : t('cross review: no problems found')}` : null,
    preview ? `🌐 ${t('site check')}: ${preview.problems ? tn(preview.problems, '{n} problem left', '{n} problems left') : t('no automatic problems')}` : null,
  ]);
}

const STEP_TEXT = localized({
  triage: 'triaging',
  draft: 'draft',
  critique: 'critique',
  revise: 'revision',
  synthesize: 'plan',
  solve: 'solution',
  answer: 'solution',
  final: 'merging',
  decompose: 'task split',
  code: 'code',
  repair: 'repair',
  compact: 'summary',
  review: 'code review',
  fix: 'fix',
  visual: 'site review',
});
const PHASE_TEXT = localized({
  draft: 'The chief is drafting',
  critique: 'The team is critiquing the draft',
  revise: 'The chief is revising the draft',
  synthesize: 'Writing the plan',
  solve: 'The chief is solving',
  answer: 'The team is solving separately',
  final: 'The chief is merging the results',
  decompose: 'Splitting into tasks',
  code: 'Writing code',
  repair: 'Repairing the output',
  review: 'Everyone reviews the others’ code',
  fix: 'Applying the review',
  visual: 'Everyone reviews the site',
});

/**
 * The live card for a turn. `p`: { kind, startedAt, phase, agents: [{ label, step,
 * state: run|ok|err, ms }], tasks, done }.
 */
export function progressCard(p, now = Date.now()) {
  const title = `${p.kind === 'question' ? '🤔' : p.kind === 'build' ? '🔨' : p.replan ? '🔄' : '🧠'} <b>${t(p.kind === 'question' ? 'Question' : p.kind === 'build' ? 'Coding' : p.replan ? 'Replanning' : 'Debate')}</b>`;
  const icon = { run: '⏳', ok: '✅', err: '⚠️' };
  if (p.done) {
    const who = p.agents.map((a) => `${a.label} ${a.state === 'err' ? '⚠️' : '✓'}`).join(' · ');
    return join([`${title} · ${p.done} · ${duration(now - p.startedAt)}`, who ? `<i>${esc(who)}</i>` : null]);
  }
  const reviewing = ['review', 'fix', 'visual'].includes(p.phase);
  const rows =
    p.kind === 'build' && p.tasks?.length && !reviewing
      ? p.tasks.map((task) => `${task.status === 'done' ? '✅' : task.status === 'failed' ? '❌' : task.status === 'running' ? '⏳' : '▫️'} <code>${esc(task.file_path)}</code>${task.workerLabel ? ` · ${esc(task.workerLabel)}` : ''}`)
      : p.agents.map((a) => `${icon[a.state]} ${esc(a.label)} · ${STEP_TEXT[a.step] || a.step || ''}${a.state === 'ok' && a.ms ? ` · ${duration(a.ms)}` : a.state === 'err' ? ` · ${t('error')}` : ''}`);
  const count = p.kind === 'build' && p.tasks?.length ? ` · ${p.tasks.filter((task) => task.status === 'done').length}/${p.tasks.length}` : '';
  return join([`${title}${count} · ${duration(now - p.startedAt)}`, p.phase ? `<i>${esc(PHASE_TEXT[p.phase] || p.phase)}…</i>` : null, '', ...rows]);
}

export function statusCard({ folder, status, session, mode, chief, workers }) {
  return join([
    `🐺 <b>${esc(folder)}</b> · ${esc(STATUS_TEXT[status] || status)}`,
    session ? `💬 ${t('Chat')} <code>${esc(session.shortId)}</code> · ${tn(session.turns, '{n} turn', '{n} turns')}${session.title ? ` · <i>${esc(short(session.title, 50))}</i>` : ''}` : null,
    `⚙️ ${t('Mode')}: <b>${esc(MODE_TEXT[mode] || mode)}</b> <i>(${esc(MODE_HINT[mode] || '')})</i>`,
    `★ ${t('Chief')}: ${esc(chief)}`,
    workers.length ? `👥 ${workers.map(esc).join(' · ')}` : null,
  ]);
}

export function helpText({ topics }) {
  return join([
    '🐺 <b>Kerberos</b>',
    t('Just write; the chief decides: chat it answers itself, a question the whole team solves, a coding job gets a plan.'),
    '',
    `/status · ${t('status and shortcuts')}`,
    `/ask · ${t('ask the whole team')}`,
    `/plan · ${t('a coding task directly')}`,
    `/new · ${t('new chat')}  /clear · ${t('also delete the messages')}`,
    `/compact · ${t('summarize the history')}`,
    `/undo · ${t('undo')}  /stop · ${t('stop')}`,
    `/mode · ${t('permission mode')}`,
    topics ? `/sessions · ${t('open projects')}` : null,
    '',
    `<i>${t('A message written while a plan waits for approval becomes feedback on the plan.')}</i>`,
  ]);
}

/** Telegram's "/" menu. */
export const commandMenu = () => [
  { command: 'status', description: t('Status and shortcuts') },
  { command: 'ask', description: t('Ask the whole team') },
  { command: 'plan', description: t('A coding task directly') },
  { command: 'new', description: t('New chat') },
  { command: 'clear', description: t('New chat, also delete the messages') },
  { command: 'compact', description: t('Summarize the chat history') },
  { command: 'undo', description: t('Undo the last change') },
  { command: 'stop', description: t('Stop the running agents') },
  { command: 'mode', description: t('Permission mode') },
  { command: 'sessions', description: t('Open projects') },
  { command: 'help', description: t('Help') },
];

/** Fallback when Telegram rejects our HTML: the same text without markup. */
export const plain = (html) =>
  String(html || '')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
