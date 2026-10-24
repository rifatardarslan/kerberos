import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Workspace, JailError } from '../src/core/workspace.js';
import { tmpDir } from './helpers.js';

const deny = ['.git', '.kerberos', 'node_modules', '.env'];

test('resolveSafe rejects escapes and protected paths', () => {
  const ws = new Workspace(tmpDir(), { denyWrite: deny });
  for (const bad of ['../x.js', 'a/../../x.js', '/etc/passwd', 'C:\\Windows\\x', 'c:/x', '\\\\server\\share\\x', '', '.git/config', '.env', 'node_modules/a/b.js', '.KERBEROS/x']) {
    assert.throws(() => ws.resolveSafe(bad), JailError, bad);
  }
  assert.equal(ws.resolveSafe('src/a.js'), path.join(ws.root, 'src', 'a.js'));
  assert.equal(ws.resolveSafe('./a/../b.js'), path.join(ws.root, 'b.js'));
  assert.ok(ws.resolveSafe('.envrc'));
});

test('resolveSafe blocks symlinked escape', (t) => {
  const root = tmpDir();
  const outside = tmpDir('kerberos-outside-');
  try {
    fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
  } catch {
    t.skip('symlink oluşturulamadı');
    return;
  }
  const ws = new Workspace(root, { denyWrite: deny });
  assert.throws(() => ws.resolveSafe('link/evil.js'), JailError);
});

test('writeFile creates directories and tracks changes', async () => {
  const ws = new Workspace(tmpDir(), { denyWrite: deny });
  await ws.writeFile('deep/nested/file.txt', 'hi');
  assert.equal(fs.readFileSync(path.join(ws.root, 'deep/nested/file.txt'), 'utf8'), 'hi');
  assert.ok(ws.changed.has('deep/nested/file.txt'));
});

test('tree honours .gitignore and fixed ignores', async () => {
  const ws = new Workspace(tmpDir(), { denyWrite: deny });
  fs.mkdirSync(path.join(ws.root, 'src'));
  fs.mkdirSync(path.join(ws.root, 'node_modules'));
  fs.writeFileSync(path.join(ws.root, 'src', 'a.js'), '');
  fs.writeFileSync(path.join(ws.root, 'secret.log'), '');
  fs.writeFileSync(path.join(ws.root, '.gitignore'), '*.log\n');
  const tree = await ws.tree();
  assert.match(tree, /src\//);
  assert.match(tree, /a\.js/);
  assert.doesNotMatch(tree, /node_modules/);
  assert.doesNotMatch(tree, /secret\.log/);
});

test('snapshot -> write -> diff -> rollback restores the original tree', async () => {
  const ws = new Workspace(tmpDir(), { denyWrite: deny });
  fs.writeFileSync(path.join(ws.root, 'keep.txt'), 'original\n');
  const sha = await ws.snapshot('test');
  assert.match(sha, /^[0-9a-f]{40}$/);

  await ws.writeFile('keep.txt', 'modified\n');
  await ws.writeFile('new/created.js', 'x\n');
  const diff = await ws.diffSummary(sha);
  const byPath = Object.fromEntries(diff.files.map((f) => [f.path, f.status]));
  assert.equal(byPath['keep.txt'], 'M');
  assert.equal(byPath['new/created.js'], 'A');

  await ws.rollback(sha);
  assert.equal(fs.readFileSync(path.join(ws.root, 'keep.txt'), 'utf8'), 'original\n');
  assert.equal(fs.existsSync(path.join(ws.root, 'new/created.js')), false);
  assert.equal(ws.loadSession().snapshot, sha);
});

test('snapshot does not touch an existing user git repo', async () => {
  const { execa } = await import('execa');
  const root = tmpDir();
  await execa('git', ['init', '-q'], { cwd: root });
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  const ws = new Workspace(root, { denyWrite: deny });
  await ws.snapshot();
  const { stdout } = await execa('git', ['status', '--porcelain'], { cwd: root });
  assert.match(stdout, /\?\? a\.txt/); // still untracked in the user's repo
  assert.match(stdout, /\?\? \.kerberos\//);
});
