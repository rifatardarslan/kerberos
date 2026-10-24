import { ClaudeAdapter } from './claude-adapter.js';
import { CodexAdapter } from './codex-adapter.js';
import { OpenCodeAdapter } from './opencode-adapter.js';
import { AgyAdapter } from './agy-adapter.js';
import { BaseAdapter } from './base-adapter.js';

const REGISTRY = {
  claude: ClaudeAdapter,
  codex: CodexAdapter,
  opencode: OpenCodeAdapter,
  agy: AgyAdapter,
};

/** Text adapter for any CLI that takes a prompt on stdin and prints plain text. */
export class GenericAdapter extends BaseAdapter {
  buildArgs() {
    return this.cfg.args || [];
  }
}

export function createAdapter(id, cfg, deps) {
  const Cls = REGISTRY[cfg.type || id] || GenericAdapter;
  return new Cls(id, cfg, deps);
}

export function createAdapters(config, deps) {
  const out = {};
  for (const [id, cfg] of Object.entries(config.agents)) {
    if (cfg.enabled === false) continue;
    out[id] = createAdapter(id, cfg, { ...deps, timeoutMs: config.timeoutMs });
  }
  return out;
}
