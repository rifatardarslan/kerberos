import { BaseAdapter, safeJson } from './base-adapter.js';

const WRITE_TOOLS = /write|edit|replace|create|delete|remove|move|rename|run_command|shell|exec/i;

/** String arguments of a tool call that look like file system targets. */
function targetPaths(info) {
  return Object.entries(info?.parameters || {})
    .filter(([k, v]) => typeof v === 'string' && /path|file|target|dir|cwd/i.test(k))
    .map(([, v]) => v);
}

/** agy's own plan artifacts (~/.gemini/antigravity-cli/brain/<conversation>/...). */
const isAgyScratch = (p) => /[\\/]\.gemini[\\/]antigravity-cli[\\/]brain[\\/]/i.test(p);

/**
 * Antigravity CLI (agy). Plain -p only accepts the prompt as an argument, which hits
 * the Windows argv limit, so the prompt is sent as one NDJSON message on stdin with
 * --input-format stream-json. Plan mode keeps it from editing files.
 *
 * Do NOT pass --disable-slash-commands: agy then silently ignores --mode plan and
 * writes straight into the workspace. As a second line of defence, any write or
 * shell tool aimed outside agy's own scratch directory kills the run.
 */
export class AgyAdapter extends BaseAdapter {
  buildArgs() {
    const a = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', this.cfg.mode || 'plan'];
    if (this.cfg.model) a.push('--model', this.cfg.model);
    if (this.cfg.effort) a.push('--effort', this.cfg.effort);
    return a;
  }

  buildInput(args) {
    const content = super.buildInput(args);
    return JSON.stringify({ event: 'user', message: { role: 'user', content } }) + '\n';
  }

  parseLine(line) {
    const ev = safeJson(line);
    if (!ev) return null;
    if (ev.event === 'step_update') {
      const s = ev.step_update || {};
      if (s.step_type === 'tool' && s.tool_name && WRITE_TOOLS.test(s.tool_name)) {
        const targets = targetPaths(s.tool_info);
        const outside = targets.filter((p) => !isAgyScratch(p));
        if (!targets.length || outside.length) return { violation: `${s.tool_name} ${outside[0] || ''}`.trim() };
      }
      if (s.step_type === 'agent_response' && s.text_delta) return { chunk: s.text_delta };
      if (s.thinking_delta) return { chunk: s.thinking_delta, kind: 'thinking' };
      if (s.step_type === 'tool' && s.state === 'ACTIVE' && s.tool_name) return { chunk: `· ${s.tool_name}\n`, kind: 'tool' };
      return null;
    }
    if (ev.event === 'result') {
      const r = ev.result || {};
      if (r.status && r.status !== 'SUCCESS') return { error: r.error || `agy status ${r.status}` };
      const u = r.usage;
      if (!u) return { final: r.response ?? '' };
      return { final: r.response ?? '', usage: { input: u.input_tokens || 0, output: (u.output_tokens || 0) + (u.thinking_tokens || 0), cached: u.cache_read_tokens || 0 } };
    }
    return null;
  }
}
