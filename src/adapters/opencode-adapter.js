import { BaseAdapter, safeJson } from './base-adapter.js';

function deepMessage(err) {
  if (!err) return null;
  if (typeof err === 'string') return err;
  return err.data?.message || err.message || err.name || JSON.stringify(err).slice(0, 300);
}

/**
 * opencode run with the read-only "plan" agent and JSON events. OpenCode has no
 * --temperature flag; the closest knob is the model variant (provider/model#variant).
 */
export class OpenCodeAdapter extends BaseAdapter {
  buildArgs() {
    const a = ['run', '--format', 'json', '--agent', this.cfg.agent || 'plan'];
    if (this.cfg.model) a.push('-m', this.cfg.variant ? `${this.cfg.model}#${this.cfg.variant}` : this.cfg.model);
    return a;
  }

  parseLine(line) {
    const ev = safeJson(line);
    if (!ev) return null;
    if (ev.type === 'text' && ev.part?.text) return { chunk: ev.part.text + '\n' };
    if (ev.type === 'reasoning' && ev.part?.text) return { chunk: ev.part.text + '\n', kind: 'thinking' };
    if (ev.type === 'tool_use' && ev.part?.tool) return { chunk: `· ${ev.part.tool}\n`, kind: 'tool' };
    if (ev.type === 'error') return { error: deepMessage(ev.error) || 'opencode error' };
    return null;
  }
}
