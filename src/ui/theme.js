// Visual identity: the three-headed hound guarding the gates of the underworld.
// Palette is underworld fire: ember red -> orange -> brimstone yellow.

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

export const TAGLINES = [
  "Hades'in kapısındaki üç başlı bekçi",
  'Üç baş, tek karar',
  'Styx kıyısında kod nöbeti',
];

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
export const VERBS = {
  draft: ["Hades'e danışıyor", 'Kehanet okuyor', 'Yeraltı haritasını çiziyor'],
  critique: ['Kokluyor', 'Diş gösteriyor', 'Styx kıyısında tartışıyor', 'Havlıyor'],
  revise: ['Pençesini bileyliyor', 'Taslağı yeniden yoğuruyor'],
  synthesize: ['Üç baş uzlaşıyor', 'Konsensüs mühürleniyor'],
  decompose: ['Görevleri paylaştırıyor', 'Kapıları atıyor'],
  code: ["Hephaistos'un örsünde dövüyor", 'Kod kazıyor', 'Kemik kemiriyor'],
  repair: ['Zinciri onarıyor'],
  compact: ['Anıları sıkıştırıyor', 'Kemikleri gömüyor'],
  triage: ['Kulak kabartıyor', 'Kokluyor'],
  answer: ['Hesap yapıyor', 'Kemik kemiriyor', 'Düşünüyor'],
  solve: ['Hesap yapıyor'],
  final: ['Üç baş uzlaşıyor', 'Cevabı mühürlüyor'],
  default: ['Düşünüyor'],
};

export function pickVerb(step, seed = 0) {
  const list = VERBS[step] || VERBS.default;
  return list[Math.abs(seed) % list.length];
}

export const STATUS_LABELS = {
  IDLE: 'hazır',
  DEBATING: 'tartışıyor',
  AWAITING_ANSWERS: 'yanıt bekliyor',
  AWAITING_APPROVAL: 'onay bekliyor',
  BUILDING: 'kodluyor',
  DONE: 'tamamlandı',
  ABORTED: 'durduruldu',
  ERROR: 'hata',
};

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
export const MODE_INFO = {
  default: { label: 'onaylı', hint: 'plan onayı istenir', color: 'gray' },
  auto: { label: '⏵⏵ otomatik', hint: 'plan onaysız kodlanır', color: '#AF87FF', footer: '⏵⏵ otomatik kodlama açık' },
  plan: { label: '⏸ yalnızca plan', hint: 'kod yazılmaz', color: PLAN, footer: '⏸ yalnızca plan modu açık' },
};

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

/** "3 dk önce", "2 sa önce", "dün", or a date. */
export function relTime(when, now = Date.now()) {
  const t = typeof when === 'number' ? when : Date.parse(when);
  if (!t) return '';
  const s = Math.round((now - t) / 1000);
  if (s < 60) return 'az önce';
  if (s < 3600) return `${Math.floor(s / 60)} dk önce`;
  if (s < 86_400) return `${Math.floor(s / 3600)} sa önce`;
  if (s < 172_800) return 'dün';
  return new Date(t).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
}

/** Reset time of a quota window given in epoch seconds: "2 sa 14 dk sonra". */
export function resetsIn(epochSec, now = Date.now()) {
  if (!epochSec) return '';
  const m = Math.max(0, Math.round((epochSec * 1000 - now) / 60_000));
  if (m < 60) return `${m} dk sonra`;
  if (m < 1440) return `${Math.floor(m / 60)} sa ${m % 60} dk sonra`;
  return new Date(epochSec * 1000).toLocaleString('tr-TR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}
