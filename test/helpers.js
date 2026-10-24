import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FAKE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-cli.js');

export function tmpDir(prefix = 'kerberos-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function fakeAgent(label, behavior = 'ok') {
  return { enabled: true, type: 'generic', label, bin: process.execPath, args: [FAKE_CLI, '--behavior', behavior] };
}
