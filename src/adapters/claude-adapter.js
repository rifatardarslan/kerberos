import { BaseAdapter, safeJson } from './base-adapter.js';

const MAX_ARGV_SYSTEM = 8000;
const WINDOW_LABEL = { five_hour: '5 saatlik oturum', seven_day: 'Haftalık', seven_day_opus: 'Haftalık (Opus)', seven_day_sonnet: 'Haftalık (Sonnet)' };

/** `rate_limit_event` -> plan quota windows (the same numbers Claude Code's /usage shows). */
export function claudeRateLimit(info = {}) {
  const wins = info.unifiedWindows || (info.rateLimitType ? { [info.rateLimitType]: info } : {});
  return {
    status: info.status,
    windows: Object.entries(wins).map(([id, w]) => ({ id, label: WINDOW_LABEL[id] || id, used: w.utilization ?? null, resetsAt: w.resetsAt ?? null, status: w.status })),
  };
}

/**
 * claude -p (print mode) with stream-json output. Built-in write/exec tools are
 * disabled and MCP servers skipped, so Claude can only read the workspace; Kerberos
 * does all writing. Thinking budget goes through MAX_THINKING_TOKENS (no CLI flag exists).
 */
export class ClaudeAdapter extends BaseAdapter {
  buildArgs({ system }) {
    const a = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--tools', this.cfg.tools ?? 'Read,Grep,Glob',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
    ];
    if (this.cfg.model) a.push('--model', this.cfg.model);
    if (this.cfg.effort) a.push('--effort', this.cfg.effort);
    if (system && system.length <= MAX_ARGV_SYSTEM) a.push('--append-system-prompt', system);
    return a;
  }

  buildInput({ prompt, system }) {
    // Oversized system prompts go through stdin to stay under the Windows argv limit.
    return system && system.length > MAX_ARGV_SYSTEM ? super.buildInput({ prompt, system }) : prompt;
  }

  buildEnv() {
    return this.cfg.thinkingTokens ? { MAX_THINKING_TOKENS: String(this.cfg.thinkingTokens) } : {};
  }

  parseLine(line, state) {
    const ev = safeJson(line);
    if (!ev) return null;
    if (ev.type === 'stream_event') {
      const d = ev.event?.delta;
      if (ev.event?.type === 'content_block_delta' && d) {
        state.sawDelta = true;
        if (d.type === 'text_delta') return { chunk: d.text };
        if (d.type === 'thinking_delta') return { chunk: d.thinking, kind: 'thinking' };
      }
      if (ev.event?.type === 'content_block_stop') return { chunk: '\n', kind: 'separator' };
      return null;
    }
    if (ev.type === 'system' && ev.subtype === 'init' && ev.model) return { model: ev.model };
    if (ev.type === 'rate_limit_event') return { rateLimit: claudeRateLimit(ev.rate_limit_info) };
    if (ev.type === 'assistant' && !state.sawDelta) {
      const text = (ev.message?.content || [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('');
      return text ? { chunk: text + '\n' } : null;
    }
    if (ev.type === 'result') {
      if (ev.is_error) {
        const status = ev.api_error_status ? ` (HTTP ${ev.api_error_status})` : '';
        return { error: `${ev.result || ev.subtype || 'hata'}${status}` };
      }
      const u = ev.usage;
      if (!u) return { final: ev.result ?? '' };
      const usage = {
        input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
        output: u.output_tokens || 0,
        cached: u.cache_read_input_tokens || 0,
        cost: ev.total_cost_usd || 0,
      };
      return { final: ev.result ?? '', usage };
    }
    return null;
  }
}
