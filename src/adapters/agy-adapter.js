import { BaseAdapter, safeJson } from './base-adapter.js';

/**
 * Antigravity CLI (agy). Plain -p only accepts the prompt as an argument, which hits
 * the Windows argv limit, so the prompt is sent as one NDJSON message on stdin with
 * --input-format stream-json. Plan mode keeps it from editing files.
 */
export class AgyAdapter extends BaseAdapter {
  buildArgs() {
    const a = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', this.cfg.mode || 'plan', '--disable-slash-commands'];
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
      if (s.step_type === 'agent_response' && s.text_delta) return { chunk: s.text_delta };
      if (s.thinking_delta) return { chunk: s.thinking_delta, kind: 'thinking' };
      if (s.step_type === 'tool' && s.state === 'ACTIVE' && s.tool_name) return { chunk: `· ${s.tool_name}\n`, kind: 'tool' };
      return null;
    }
    if (ev.event === 'result') {
      const r = ev.result || {};
      if (r.status && r.status !== 'SUCCESS') return { error: r.error || `agy status ${r.status}` };
      return { final: r.response ?? '' };
    }
    return null;
  }
}
