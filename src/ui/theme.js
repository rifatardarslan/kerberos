const AGENT_COLORS = {
  claude: '#D97757',
  codex: 'green',
  opencode: 'cyan',
  agy: '#4C8BF5',
};
const FALLBACK = ['magenta', 'yellow', 'blueBright', 'greenBright'];

export function agentColor(id) {
  if (AGENT_COLORS[id]) return AGENT_COLORS[id];
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return FALLBACK[h % FALLBACK.length];
}

export const STATUS_COLORS = {
  IDLE: 'gray',
  DEBATING: 'yellow',
  AWAITING_APPROVAL: 'magenta',
  BUILDING: 'cyan',
  DONE: 'green',
  ABORTED: 'red',
  ERROR: 'red',
};

export const STATUS_LABELS = {
  IDLE: 'IDLE',
  DEBATING: 'DEBATING',
  AWAITING_APPROVAL: 'ONAY BEKLİYOR',
  BUILDING: 'BUILDING',
  DONE: 'DONE',
  ABORTED: 'ABORTED',
  ERROR: 'ERROR',
};

/** Hard-wrap a line to `width` columns (Ink wrapping would break the viewport math). */
export function wrapLine(text, width) {
  if (width <= 0) return [text];
  const out = [];
  for (const raw of String(text).replace(/\t/g, '  ').split('\n')) {
    if (raw.length <= width) {
      out.push(raw);
      continue;
    }
    let rest = raw;
    while (rest.length > width) {
      // Prefer breaking at the last space in the window; fall back to a hard cut.
      const space = rest.lastIndexOf(' ', width);
      const cut = space > width * 0.5 ? space : width;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^ /, '');
    }
    out.push(rest);
  }
  return out;
}
