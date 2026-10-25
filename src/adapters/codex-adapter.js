import fs from 'node:fs/promises';
import { BaseAdapter, safeJson } from './base-adapter.js';

/**
 * codex exec in a read-only sandbox, JSONL events on stdout and the final message
 * written to a temp file via -o. Reasoning effort is a config override, not a flag.
 */
export class CodexAdapter extends BaseAdapter {
  async prepare() {
    return { lastFile: await this.workspace.tmpFile('codex-last.txt', '') };
  }

  buildArgs({ lastFile }) {
    const a = ['exec'];
    if (this.cfg.model) a.push('-m', this.cfg.model);
    if (this.cfg.effort) a.push('-c', `model_reasoning_effort="${this.cfg.effort}"`);
    a.push('-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '--json', '--color', 'never', '-o', lastFile, '-');
    return a;
  }

  parseLine(line) {
    const ev = safeJson(line);
    if (!ev) return null;
    // Current event format
    if (ev.type === 'item.completed' || ev.type === 'item.updated') {
      const item = ev.item || {};
      if (item.type === 'agent_message' && ev.type === 'item.completed') return { chunk: (item.text || '') + '\n' };
      if (item.type === 'reasoning' && item.text) return { chunk: item.text + '\n', kind: 'thinking' };
      if (item.type === 'command_execution' && item.command) return { chunk: `$ ${item.command}\n`, kind: 'tool' };
      return null;
    }
    if (ev.type === 'turn.completed' && ev.usage) {
      const u = ev.usage;
      return { usage: { input: u.input_tokens || 0, output: (u.output_tokens || 0) + (u.reasoning_output_tokens || 0), cached: u.cached_input_tokens || 0 } };
    }
    if (ev.type === 'turn.failed') return { error: ev.error?.message || 'turn failed' };
    if (ev.type === 'error') return { error: ev.message || ev.error?.message || 'codex error' };
    // Legacy event format: { msg: { type, message } }
    const msg = ev.msg;
    if (msg?.type === 'agent_message') return { chunk: (msg.message || '') + '\n' };
    if (msg?.type === 'agent_reasoning') return { chunk: (msg.text || '') + '\n', kind: 'thinking' };
    if (msg?.type === 'error' || msg?.type === 'stream_error') return { error: msg.message || 'codex error' };
    return null;
  }

  async finalize(state, { lastFile }) {
    try {
      const last = (await fs.readFile(lastFile, 'utf8')).trim();
      if (last) state.final = last;
    } finally {
      await fs.rm(lastFile, { force: true });
    }
  }
}
