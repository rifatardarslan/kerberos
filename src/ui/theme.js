import { getLanguage, localized, t } from '../i18n/index.js';

// Visual identity: the three-headed hound guarding the gates of the underworld.
// Palette is underworld fire: ember red -> orange -> brimstone yellow.

export { localized };

/** Locale for dates and numbers in the interface language. */
export const uiLocale = () => (getLanguage() === 'tr' ? 'tr-TR' : 'en-US');

export const BRAND = '#E8572A';
export const FIRE = ['#B71C1C', '#D84315', '#E8572A', '#F57C00', '#FF9800', '#F57C00', '#D84315'];
export const EYE = '#FFD54F';
export const DIM = 'gray';

// Claude Code's palette for the parts that mimic it.
export const SUGGEST = '#B1B9F9'; // selected suggestion / choice
export const PLAN = '#48968C'; // plan box
export const SUBTLE = '#888888';
// Windows consoles draw ⏺ as a wide emoji; Claude Code uses ● there too.
export const BULLET = process.platform === 'win32' ? '●' : '⏺';

/** Three heads: chief in the middle, workers on either side. */
export const HOUND = [
  '  ▲   ▲     ▲   ▲     ▲   ▲  ',
  ' ▟█▙▄▟█▙   ▟█▙▄▟█▙   ▟█▙▄▟█▙ ',
  ' █ ◉ ◉ █   █ ◉ ◉ █   █ ◉ ◉ █ ',
  ' ▜█▄▼▄█▛   ▜█▄▼▄█▛   ▜█▄▼▄█▛ ',
  '   ▀█▄▄▄▄▄▄▄▄█▀█▄▄▄▄▄▄▄▄█▀   ',
  '       ▜█████████████▛       ',
  '        ▐█▌ ▐█▌ ▐█▌ ▐█▌      ',
];

export const TAGLINES = localized(['The three-headed guard at the gates of Hades', 'Three heads, one decision', 'Code watch on the banks of the Styx']);

const AGENT_COLORS = {
  claude: '#D97757',
  codex: '#10A37F',
  opencode: '#00BCD4',
  agy: '#4C8BF5',
};
const FALLBACK = ['magenta', 'yellow', 'blueBright', 'greenBright'];

export function agentColor(id) {
  if (AGENT_COLORS[id]) return AGENT_COLORS[id];
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return FALLBACK[h % FALLBACK.length];
}

/** Spinner glyphs (the hound's ember breath). */
export const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

/** Mythological status verbs, chosen per call step. */
export const VERBS = localized({
  draft: ['Consulting Hades', 'Reading the oracle', 'Mapping the underworld'],
  critique: ['Sniffing', 'Baring teeth', 'Arguing on the Styx', 'Barking'],
  revise: ['Sharpening claws', 'Kneading the draft'],
  synthesize: ['Three heads agreeing', 'Sealing the consensus'],
  decompose: ['Handing out tasks', 'Assigning the gates'],
  code: ["Forging on Hephaestus' anvil", 'Carving code', 'Gnawing a bone'],
  repair: ['Mending the chain'],
  review: ['Sniffing each other’s code', 'Checking the bite marks', 'Inspecting the gates'],
  fix: ['Polishing the fangs', 'Licking the wounds', 'Tightening the chain'],
  visual: ['Prowling the site', 'Eyeing the pages', 'Guarding the gallery'],
  compact: ['Compressing memories', 'Burying bones'],
  triage: ['Pricking up ears', 'Sniffing'],
  answer: ['Calculating', 'Gnawing a bone', 'Thinking'],
  solve: ['Calculating'],
  final: ['Three heads agreeing', 'Sealing the answer'],
  default: ['Thinking'],
});

export function pickVerb(step, seed = 0) {
  const list = VERBS[step] || VERBS.default;
  return list[Math.abs(seed) % list.length];
}

export const STATUS_LABELS = localized({
  IDLE: 'ready',
  DEBATING: 'debating',
  AWAITING_ANSWERS: 'awaiting answers',
  AWAITING_APPROVAL: 'awaiting approval',
  BUILDING: 'coding',
  DONE: 'done',
  ABORTED: 'stopped',
  ERROR: 'error',
});

/** What an agent call is for, as shown next to its name. */
export const STEP_LABELS = localized({
  draft: 'draft',
  critique: 'critique',
  revise: 'revision',
  synthesize: 'synthesis',
  decompose: 'task split',
  code: 'code',
  repair: 'repair',
  review: 'code review',
  fix: 'fix',
  visual: 'site review',
  compact: 'context summary',
  triage: 'triage',
  reply: 'reply',
  solve: 'solution',
  answer: 'solution',
  final: 'result',
});

export const STATUS_COLORS = {
  IDLE: DIM,
  DEBATING: 'yellow',
  AWAITING_ANSWERS: 'yellow',
  AWAITING_APPROVAL: 'magenta',
  BUILDING: 'cyan',
  DONE: 'green',
  ABORTED: 'red',
  ERROR: 'red',
};

/** Shorten a path for the footer: keep the last segments. */
export function shortPath(p, max = 40) {
  if (p.length <= max) return p;
  const parts = p.split(/[\\/]/);
  let out = parts.pop();
  while (parts.length && out.length + parts[parts.length - 1].length + 1 < max - 2) out = `${parts.pop()}/${out}`;
  return `…/${out}`;
}

/** Hard-wrap a line to `width` columns, preferring word boundaries. */
export function wrapLine(text, width) {
  if (width <= 0) return [text];
  const out = [];
  for (const raw of String(text).replace(/\t/g, '  ').split('\n')) {
    let rest = raw;
    while (rest.length > width) {
      const space = rest.lastIndexOf(' ', width);
      const cut = space > width * 0.5 ? space : width;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^ /, '');
    }
    out.push(rest);
  }
  return out;
}

/** Permission modes as shown in the footer (Claude Code's "⏵⏵ accept edits on"). */
export const MODE_INFO = localized({
  default: { label: 'ask', hint: 'asks before coding the plan', color: 'gray' },
  auto: { label: '⏵⏵ auto', hint: 'codes the plan without asking', color: '#AF87FF', footer: '⏵⏵ auto-code on' },
  plan: { label: '⏸ plan only', hint: 'plans first; coding needs your approval', color: PLAN, footer: '⏸ plan mode on' },
});

/** 1234 -> "1.2k", 1234567 -> "1.2M". */
export function fmtTokens(n = 0) {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export const fmtCost = (usd) => (usd >= 0.995 ? `$${usd.toFixed(2)}` : usd > 0 ? `$${usd.toFixed(3)}` : '');

/** Usage bar: used fraction 0..1 drawn in `width` cells. */
export function bar(used, width = 24) {
  const f = Math.max(0, Math.min(1, used ?? 0));
  const full = Math.round(f * width);
  return { filled: '█'.repeat(full), empty: '░'.repeat(width - full) };
}

export const usageColor = (used) => (used >= 0.9 ? 'red' : used >= 0.7 ? 'yellow' : 'green');

/** "3m ago", "2h ago", "yesterday", or a date. */
export function relTime(when, now = Date.now()) {
  const at = typeof when === 'number' ? when : Date.parse(when);
  if (!at) return '';
  const s = Math.round((now - at) / 1000);
  if (s < 60) return t('just now');
  if (s < 3600) return t('{n}m ago', { n: Math.floor(s / 60) });
  if (s < 86_400) return t('{n}h ago', { n: Math.floor(s / 3600) });
  if (s < 172_800) return t('yesterday');
  return new Date(at).toLocaleDateString(uiLocale(), { day: 'numeric', month: 'short' });
}

/** Reset time of a quota window given in epoch seconds: "in 2h 14m". */
export function resetsIn(epochSec, now = Date.now()) {
  if (!epochSec) return '';
  const m = Math.max(0, Math.round((epochSec * 1000 - now) / 60_000));
  if (m < 60) return t('in {m}m', { m });
  if (m < 1440) return t('in {h}h {m}m', { h: Math.floor(m / 60), m: m % 60 });
  return new Date(epochSec * 1000).toLocaleString(uiLocale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}
