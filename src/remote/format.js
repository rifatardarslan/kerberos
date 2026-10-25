// Telegram message layout: HTML cards for plans, results, progress and status, and a
// small Markdown → Telegram-HTML converter for agent answers. Pure functions only.

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const STATUS_TEXT = { IDLE: 'hazır', DEBATING: 'düşünüyor', AWAITING_ANSWERS: 'yanıt bekliyor', AWAITING_APPROVAL: 'onay bekliyor', BUILDING: 'kodluyor', DONE: 'tamamlandı', ABORTED: 'durduruldu', ERROR: 'hata' };
export const MODE_TEXT = { default: 'onaylı', auto: 'otomatik', plan: 'yalnızca plan' };
export const MODE_HINT = { default: 'plan onayı istenir', auto: 'plan onaysız kodlanır', plan: 'kod yazılmaz' };
export const SOURCE_TEXT = { tui: 'TUI', telegram: 'Telegram', auto: 'otomatik mod', system: 'sistem' };
const FILE_ICON = { A: '🟢', M: '🟡', D: '🔴', R: '🔵' };

const MAX = 3900;
const short = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const join = (lines) => lines.filter((l) => l !== null && l !== undefined && l !== false).join('\n');

export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} sn` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
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
    plan.dependencies?.length ? `📦 <b>Bağımlılıklar</b>\n${plan.dependencies.map((d) => `• ${esc(d)}`).join('\n')}` : null,
    plan.risks?.length ? `⚠️ <b>Riskler</b>\n${plan.risks.map((r) => `• ${esc(r)}`).join('\n')}` : null,
    plan.steps?.length ? `🪜 <b>Adımlar</b>\n${plan.steps.map((st, i) => `${i + 1}. ${esc(st)}`).join('\n')}` : null,
  ]);
  const text = join([
    `📋 <b>Plan hazır</b>${files.length ? ` · ${files.length} dosya` : ''}`,
    prompted(prompt, source),
    '',
    mdToHtml(plan.summary),
    files.length ? `\n📄 <b>Dosyalar</b>\n${files.map((f) => `<code>${esc(f)}</code>`).join('\n')}` : '\nℹ️ Dosya değişikliği yok.',
    plan.questions?.length ? `\n❓ <b>Şefin soruları</b>\n${plan.questions.map((q) => `• ${esc(q)}`).join('\n')}` : null,
    extra ? `\n<blockquote expandable>${extra}</blockquote>` : null,
    `\n<i>${plan.questions?.length ? 'Yanıtınızı yazın, plan ona göre yenilenir.' : 'Değişiklik isterseniz yazmanız yeterli.'}</i>`,
  ]);
  return text.length > MAX ? `${text.slice(0, MAX - 20)}…` : text;
}

/** One of the chief's clarifying questions; the options are the buttons below it. */
export function questionCard({ questions, answers = [], index, prompt, source }) {
  const q = questions[index];
  const done = questions.map((x, i) => (answers[i] != null ? `☑️ ${esc(x.header || `Soru ${i + 1}`)}: <i>${esc([].concat(answers[i]).join(', '))}</i>` : null)).filter(Boolean);
  const text = join([
    `❓ <b>Şefin sorusu</b>${questions.length > 1 ? ` · ${index + 1}/${questions.length}` : ''}`,
    prompted(prompt, source),
    done.length ? done.join('\n') : null,
    '',
    `<b>${esc(q.question)}</b>`,
    q.options.some((o) => o.description) ? q.options.map((o) => `• <b>${esc(o.label)}</b>${o.description ? ` · ${esc(o.description)}` : ''}`).join('\n') : null,
    `\n<i>${q.multiSelect ? 'Birden fazla seçip ✅ Tamam’a basın' : 'Bir seçenek seçin'} ya da yanıtınızı yazın.</i>`,
  ]);
  return text.length > MAX ? `${text.slice(0, MAX - 20)}…` : text;
}

/** The questions with the user's answers, once all are answered. */
export function answersCard(questions, answers) {
  return join(['❓ <b>Sorular yanıtlandı</b>', ...questions.map((q, i) => `• ${esc(q.question)}\n  → <b>${esc([].concat(answers[i] ?? '').join(', '))}</b>`)]);
}

export function doneCard(diff, tasks = [], error) {
  const files = diff?.files || [];
  const added = files.reduce((n, f) => n + (f.added || 0), 0);
  const removed = files.reduce((n, f) => n + (f.removed || 0), 0);
  const failed = tasks.filter((t) => t.status === 'failed');
  const rows = files.slice(0, 30).map((f) => {
    const nums = [f.added ? `+${f.added}` : null, f.removed ? `−${f.removed}` : null].filter(Boolean).join(' ');
    return `${FILE_ICON[f.status] || '⚪'} <code>${esc(f.path)}</code>${nums ? ` <i>${nums}</i>` : ''}`;
  });
  return join([
    `${error ? '⚠️ <b>Kısmen kodlandı</b>' : '✅ <b>Kodlandı</b>'} · ${files.length} dosya${added || removed ? ` · +${added} −${removed}` : ''}`,
    '',
    rows.length ? rows.join('\n') : 'Değişiklik yok.',
    files.length > 30 ? `<i>… ve ${files.length - 30} dosya daha</i>` : null,
    failed.length ? `\n❌ <b>Yazılamadı</b>: ${failed.map((t) => `<code>${esc(t.file_path)}</code>`).join(', ')}` : null,
  ]);
}

const STEP_TEXT = {
  triage: 'değerlendiriyor',
  draft: 'taslak',
  critique: 'eleştiri',
  revise: 'revizyon',
  synthesize: 'plan',
  solve: 'çözüm',
  answer: 'çözüm',
  final: 'birleştiriyor',
  decompose: 'görev dağıtımı',
  code: 'kod',
  repair: 'onarım',
  compact: 'özet',
};
const PHASE_TEXT = {
  draft: 'Şef taslak yazıyor',
  critique: 'Ekip taslağı eleştiriyor',
  revise: 'Şef taslağı düzeltiyor',
  synthesize: 'Plan yazılıyor',
  solve: 'Şef çözüyor',
  answer: 'Ekip ayrı ayrı çözüyor',
  final: 'Şef sonuçları birleştiriyor',
  decompose: 'Görevler dağıtılıyor',
  code: 'Kod yazılıyor',
  repair: 'Çıktı onarılıyor',
};

/**
 * The live card for a turn. `p`: { kind, startedAt, phase, agents: [{ label, step,
 * state: run|ok|err, ms }], tasks, done }.
 */
export function progressCard(p, now = Date.now()) {
  const title = p.kind === 'question' ? '🤔 <b>Soru</b>' : p.kind === 'build' ? '🔨 <b>Kodlanıyor</b>' : p.replan ? '🔄 <b>Yeniden planlanıyor</b>' : '🧠 <b>Tartışma</b>';
  const icon = { run: '⏳', ok: '✅', err: '⚠️' };
  if (p.done) {
    const who = p.agents.map((a) => `${a.label} ${a.state === 'err' ? '⚠️' : '✓'}`).join(' · ');
    return join([`${title} · ${p.done} · ${duration(now - p.startedAt)}`, who ? `<i>${esc(who)}</i>` : null]);
  }
  const rows =
    p.kind === 'build' && p.tasks?.length
      ? p.tasks.map((t) => `${t.status === 'done' ? '✅' : t.status === 'failed' ? '❌' : t.status === 'running' ? '⏳' : '▫️'} <code>${esc(t.file_path)}</code>${t.workerLabel ? ` · ${esc(t.workerLabel)}` : ''}`)
      : p.agents.map((a) => `${icon[a.state]} ${esc(a.label)} · ${STEP_TEXT[a.step] || a.step || ''}${a.state === 'ok' && a.ms ? ` · ${duration(a.ms)}` : a.state === 'err' ? ' · hata' : ''}`);
  const count = p.kind === 'build' && p.tasks?.length ? ` · ${p.tasks.filter((t) => t.status === 'done').length}/${p.tasks.length}` : '';
  return join([`${title}${count} · ${duration(now - p.startedAt)}`, p.phase ? `<i>${esc(PHASE_TEXT[p.phase] || p.phase)}…</i>` : null, '', ...rows]);
}

export function statusCard({ folder, status, session, mode, chief, workers }) {
  return join([
    `🐺 <b>${esc(folder)}</b> · ${esc(STATUS_TEXT[status] || status)}`,
    session ? `💬 Sohbet <code>${esc(session.shortId)}</code> · ${session.turns} tur${session.title ? ` · <i>${esc(short(session.title, 50))}</i>` : ''}` : null,
    `⚙️ Mod: <b>${esc(MODE_TEXT[mode] || mode)}</b> <i>(${esc(MODE_HINT[mode] || '')})</i>`,
    `★ Şef: ${esc(chief)}`,
    workers.length ? `👥 ${workers.map(esc).join(' · ')}` : null,
  ]);
}

export function helpText({ topics }) {
  return join([
    '🐺 <b>Kerberos</b>',
    'Yazmanız yeterli, şef karar verir: sohbetse kendisi yanıtlar, soruysa bütün ekip çözer, kod işiyse plan çıkarır.',
    '',
    '/status · durum ve kısayollar',
    '/ask · bütün ekibe sor',
    '/plan · doğrudan kod görevi',
    '/new · yeni sohbet  /clear · mesajları da sil',
    '/compact · geçmişi özetle',
    '/undo · geri al  /stop · durdur',
    '/mode · izin modu',
    topics ? '/sessions · açık projeler' : null,
    '',
    '<i>Plan onay beklerken yazdığınız mesaj plana geri bildirim olur.</i>',
  ]);
}

/** Telegram's "/" menu. */
export const COMMAND_MENU = [
  { command: 'status', description: 'Durum ve kısayollar' },
  { command: 'ask', description: 'Bütün ekibe soru sor' },
  { command: 'plan', description: 'Doğrudan kod görevi' },
  { command: 'new', description: 'Yeni sohbet' },
  { command: 'clear', description: 'Yeni sohbet, mesajları da sil' },
  { command: 'compact', description: 'Sohbet geçmişini özetle' },
  { command: 'undo', description: 'Son değişikliği geri al' },
  { command: 'stop', description: 'Çalışan ajanları durdur' },
  { command: 'mode', description: 'İzin modu' },
  { command: 'sessions', description: 'Açık projeler' },
  { command: 'help', description: 'Yardım' },
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
