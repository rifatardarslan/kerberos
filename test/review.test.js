import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { groupFindings } from '../src/core/orchestrator.js';
import { ReviewSchema, parseWith } from '../src/core/protocol.js';
import { detectSite, formatReport, previewIntent, serveStatic } from '../src/core/preview.js';
import { codeReview, fixFile, siteReview } from '../src/core/prompts.js';
import { tmpDir } from './helpers.js';

const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

test('ReviewSchema accepts loose findings and normalises severity', () => {
  const r = parseWith(ReviewSchema, '```json\n{"findings":[{"file":"a.js","severity":"HIGH","issue":"x"},{"file":"b.js","severity":"huge","issue":"y","fix":"z"}]}\n```');
  assert.deepEqual(
    r.findings.map((f) => [f.file, f.severity, f.fix]),
    [
      ['a.js', 'high', ''],
      ['b.js', 'medium', 'z'],
    ],
  );
  assert.deepEqual(parseWith(ReviewSchema, '[]').findings, []);
  assert.deepEqual(parseWith(ReviewSchema, '{"findings":[]}').findings, []);
});

test('groupFindings sorts by severity and drops duplicates per file', () => {
  const by = groupFindings([
    { file: 'a.js', severity: 'low', issue: 'naming', by: 'W1' },
    { file: 'a.js', severity: 'high', issue: 'Crash on empty input', by: 'W2' },
    { file: 'a.js', severity: 'medium', issue: 'crash on empty input', by: 'Chief' },
    { file: 'b.css', severity: 'medium', issue: 'overflow', by: 'W1' },
  ]);
  assert.deepEqual([...by.keys()], ['a.js', 'b.css']);
  assert.deepEqual(
    by.get('a.js').map((f) => f.severity),
    ['high', 'low'],
  );
});

test('detectSite: static pages, npm dev servers, and nothing for non-web changes', () => {
  const plain = tmpDir();
  write(plain, 'index.html', '<h1>x</h1>');
  assert.equal(detectSite(plain, ['server.py']), null);
  assert.deepEqual(detectSite(plain, ['style.css']), { kind: 'static', root: plain, entry: '/' });

  const pub = tmpDir();
  write(pub, 'public/index.html', '<h1>x</h1>');
  assert.equal(detectSite(pub, ['public/index.html']).root, path.join(pub, 'public'));

  const vite = tmpDir();
  write(vite, 'package.json', JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^6' } }));
  assert.deepEqual(detectSite(vite, ['src/App.jsx']), { kind: 'npm', script: 'dev', install: true });
  fs.mkdirSync(path.join(vite, 'node_modules'));
  assert.equal(detectSite(vite, ['src/App.jsx']).install, false);
  assert.equal(detectSite(vite, ['package.json']).install, true);

  const api = tmpDir();
  write(api, 'package.json', JSON.stringify({ scripts: { start: 'node server.js' }, dependencies: { express: '^5' } }));
  assert.equal(detectSite(api, ['server.js']), null); // a backend, not a site
});

test('previewIntent says whether approving a plan also runs npm', () => {
  const root = tmpDir();
  assert.equal(previewIntent(root, ['src/main.py']), null);
  assert.equal(previewIntent(root, ['index.html', 'style.css']), 'static');
  assert.equal(previewIntent(root, ['package.json', 'src/App.jsx']), 'npm');
});

test('the static server never serves files outside its root', async () => {
  const parent = tmpDir();
  write(parent, 'secret.txt', 'top secret');
  write(parent, 'site/index.html', '<h1>hi</h1>');
  write(parent, 'site/about.html', '<h1>about</h1>');
  const srv = await serveStatic(path.join(parent, 'site'));
  try {
    assert.equal(await (await fetch(`${srv.url}/`)).text(), '<h1>hi</h1>');
    assert.equal(await (await fetch(`${srv.url}/about`)).text(), '<h1>about</h1>'); // clean URLs
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/%2e%2e%5csecret.txt']) {
      const res = await fetch(`${srv.url}${p}`);
      assert.notEqual(await res.text(), 'top secret', p);
    }
  } finally {
    await srv.close();
  }
});

test('review prompts carry the files, findings, screenshots and the JSON contract', () => {
  const plan = { summary: 'S', files_to_modify: ['a.js'] };
  const review = codeReview({ request: 'yap', plan, label: 'Codex', files: [{ path: 'a.js', authorLabel: 'Claude', content: 'let x' }] });
  assert.match(review, /--- a\.js \(written by Claude\) ---\nlet x/);
  assert.match(review, /"findings"/);
  const fix = fixFile({ request: 'yap', plan, path: 'a.js', content: 'let x', findings: [{ severity: 'high', by: 'Codex', issue: 'bad', fix: 'good' }] });
  assert.match(fix, /=== FILE: a\.js ===/);
  assert.match(fix, /\[high\] \(Codex\) bad\n {2}fix: good/);
  assert.match(fix, /NO_CHANGES/);
  const site = siteReview({ request: 'site', report: 'Site: x', shots: ['/p/01-home-desktop.jpg'], files: ['index.html'], label: 'Codex' });
  assert.match(site, /- \/p\/01-home-desktop\.jpg/);
  assert.match(site, /index\.html/);
});

test('formatReport lists problems, buttons and screenshots relative to the workspace', () => {
  const root = path.resolve('/w');
  const text = formatReport(
    {
      url: 'http://127.0.0.1:1',
      pages: [{ path: '/', viewport: 'desktop', title: 'T', problems: ['button "Go" did nothing when clicked'], clicked: ['Go'] }],
      shots: [{ file: path.join(root, '.kerberos', 'preview', '01-home-desktop.jpg'), page: '/', viewport: 'desktop', width: 1440 }],
    },
    { root },
  );
  assert.match(text, /\[desktop \/\] button "Go" did nothing/);
  assert.match(text, /clicked: "Go"/);
  assert.match(text, /- \.kerberos\/preview\/01-home-desktop\.jpg \(desktop 1440px, \/\)/);
});
