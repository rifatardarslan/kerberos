import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execa } from 'execa';
import { killTree } from './process-pool.js';

// Site check after coding: KERBEROS (not the agents, which stay read-only) serves the
// site, opens it in headless Chrome/Edge over the DevTools protocol, uses it at desktop
// and phone width (pages, buttons, console, network) and takes screenshots that the
// agents then review.

export const WEB_EXT = /\.(html?|css|scss|sass|less|jsx?|tsx?|mjs|vue|svelte|astro)$/i;
const PKG = /(^|\/)package\.json$/i;
const FRONTEND_DEPS = [
  'vite', 'next', 'react-scripts', 'nuxt', 'astro', '@sveltejs/kit', 'svelte', 'vue', 'react', 'preact', 'solid-js', 'lit', 'parcel',
  'webpack-dev-server', '@angular/core', 'gatsby', '@remix-run/dev', '@11ty/eleventy', 'serve', 'http-server', 'live-server',
];
const SCRIPTS = ['dev', 'start', 'preview', 'serve'];
const INDEX = ['index.html', 'public/index.html', 'src/index.html', 'docs/index.html', 'site/index.html', 'www/index.html', 'dist/index.html'];

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, maxHeight: 3000 },
  mobile: { width: 390, height: 844, deviceScaleFactor: 1, mobile: true, maxHeight: 2400 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * What kind of site the workspace is, if the turn touched web files:
 * { kind: 'npm', script, install } for a dev-server project, { kind: 'static', root, entry }
 * for plain HTML, or null.
 */
export function detectSite(root, changed = []) {
  if (!changed.some((p) => WEB_EXT.test(p) || PKG.test(p))) return null;
  const pkg = readJson(path.join(root, 'package.json'));
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const frontend = FRONTEND_DEPS.some((d) => d in deps) || fs.existsSync(path.join(root, 'index.html'));
    const script = SCRIPTS.find((s) => pkg.scripts?.[s]);
    if (frontend && script) {
      const install = !fs.existsSync(path.join(root, 'node_modules')) || changed.some((p) => /^package\.json$/i.test(p));
      return { kind: 'npm', script, install };
    }
  }
  const index = INDEX.find((p) => fs.existsSync(path.join(root, p)));
  if (index) return { kind: 'static', root: path.join(root, path.dirname(index)), entry: '/' };
  const html = changed.find((p) => /\.html?$/i.test(p) && fs.existsSync(path.join(root, p)));
  return html ? { kind: 'static', root, entry: `/${html}` } : null;
}

/** For the approval box: will a planned change get a site check, and does it need npm? */
export function previewIntent(root, files = []) {
  if (!files.some((p) => WEB_EXT.test(p) || PKG.test(p))) return null;
  if (files.some((p) => /^package\.json$/i.test(p))) return 'npm';
  const site = detectSite(root, files);
  return site?.kind || (files.some((p) => /\.html?$/i.test(p)) ? 'static' : null);
}

// ---------------------------------------------------------------- serving

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.txt': 'text/plain; charset=utf-8',
};

/** Plain static file server on 127.0.0.1 that never serves anything outside `root`. */
export function serveStatic(root) {
  const server = http.createServer(async (req, res) => {
    try {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let file = path.join(root, rel);
      const inside = path.relative(root, file);
      if (inside.startsWith('..') || path.isAbsolute(inside)) throw Object.assign(new Error('forbidden'), { code: 403 });
      const stat = await fsp.stat(file).catch(() => null);
      if (stat?.isDirectory()) file = path.join(file, 'index.html');
      else if (!stat && !path.extname(rel)) file = `${file}.html`;
      const body = await fsp.readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch (err) {
      res.writeHead(err.code === 403 ? 403 : 404, { 'content-type': 'text/plain' });
      res.end(err.code === 403 ? 'Forbidden' : 'Not found');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?[^\s'"\x1b]*/;
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** Run a long-lived process tracked by the pool (killed on abort / exit). */
function spawnTracked(pool, cmd, args, { cwd, signal }) {
  const child = execa(cmd, args, {
    cwd,
    env: { BROWSER: 'none', NO_COLOR: '1', FORCE_COLOR: '0' },
    buffer: false,
    reject: false,
    windowsHide: true,
    stdin: 'ignore',
    detached: process.platform !== 'win32',
  });
  const release = pool?.adopt(child, { agent: 'preview' });
  const onAbort = () => killTree(child);
  signal?.addEventListener('abort', onAbort, { once: true });
  const stop = () => {
    signal?.removeEventListener('abort', onAbort);
    killTree(child);
    release?.();
  };
  child.catch(() => {});
  return { child, stop };
}

/** `npm install` (when needed) and `npm run <script>`; resolves once the dev server prints its URL. */
export async function startNpm(root, { script, install, pool, signal, log = () => {}, installTimeoutMs = 300_000, startTimeoutMs = 90_000 }) {
  if (install) {
    log('npm install');
    const { child, stop } = spawnTracked(pool, 'npm', ['install', '--no-audit', '--no-fund'], { cwd: root, signal });
    let err = '';
    child.stderr?.on('data', (d) => (err = (err + d).slice(-2000)));
    const timer = setTimeout(stop, installTimeoutMs);
    const res = await child;
    clearTimeout(timer);
    stop();
    if (signal?.aborted) throw new Error('aborted');
    if (res.exitCode !== 0) throw new Error(`npm install failed (${res.exitCode ?? 'timeout'}): ${stripAnsi(err).trim().split('\n').slice(-3).join(' | ')}`);
  }
  log(`npm run ${script}`);
  const { child, stop } = spawnTracked(pool, 'npm', ['run', script], { cwd: root, signal });
  let out = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`npm run ${script}: no local URL within ${Math.round(startTimeoutMs / 1000)}s`)), startTimeoutMs);
    const onData = (d) => {
      out = (out + stripAnsi(String(d))).slice(-4000);
      const m = URL_RE.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m[0].replace('0.0.0.0', '127.0.0.1').replace(/[/.,;:]+$/, ''));
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.then((res) => {
      clearTimeout(timer);
      reject(new Error(`npm run ${script} exited (${res.exitCode}): ${out.trim().split('\n').slice(-3).join(' | ')}`));
    });
  }).catch((err) => {
    stop();
    throw err;
  });
  return { url, close: async () => stop() };
}

// ---------------------------------------------------------------- browser

/** Chrome / Edge / Chromium on this machine (config or KERBEROS_BROWSER first). */
export function findBrowser(preferred = null, env = process.env) {
  const list = [preferred, env.KERBEROS_BROWSER].filter(Boolean);
  if (process.platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) {
      list.push(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(r, 'Chromium', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    for (const dir of (env.PATH || '').split(path.delimiter)) {
      for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) list.push(path.join(dir, bin));
    }
  }
  return list.find((p) => p && fs.existsSync(p)) || null;
}

/** Minimal DevTools protocol client over Node's built-in WebSocket. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.handlers.get(msg.method) || []) fn(msg.params || {});
      }
    });
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('browser closed'));
      this.pending.clear();
    });
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new Cdp(ws)), { once: true });
      ws.addEventListener('error', () => reject(new Error('could not connect to the browser')), { once: true });
    });
  }

  send(method, params = {}, sessionId, timeoutMs = 30_000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  once(method, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(null), timeoutMs);
      const done = (v) => {
        clearTimeout(timer);
        const list = this.handlers.get(method) || [];
        this.handlers.set(method, list.filter((f) => f !== done));
        resolve(v);
      };
      this.on(method, done);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // gone
    }
  }
}

/** Launch the browser headless with a throwaway profile; returns { cdp, close }. */
export async function launchBrowser(bin, { pool, signal } = {}) {
  const profile = path.join(os.tmpdir(), `kerberos-browser-${crypto.randomBytes(4).toString('hex')}`);
  await fsp.mkdir(profile, { recursive: true });
  const args = [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--disable-background-networking', 'about:blank',
  ];
  const { stop } = spawnTracked(pool, bin, args, { cwd: profile, signal });
  const close = async (cdp) => {
    cdp?.close();
    stop();
    await sleep(300);
    await fsp.rm(profile, { recursive: true, force: true }).catch(() => {});
  };
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    let lines = null;
    for (let i = 0; i < 100 && !lines; i++) {
      if (signal?.aborted) throw new Error('aborted');
      const text = await fsp.readFile(portFile, 'utf8').catch(() => '');
      if (text.includes('\n')) lines = text.trim().split(/\r?\n/);
      else await sleep(150);
    }
    if (!lines) throw new Error('the browser did not start');
    const cdp = await Cdp.connect(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
    return { cdp, close: () => close(cdp) };
  } catch (err) {
    await close();
    throw err;
  }
}

// ---------------------------------------------------------------- using the site

const PROBE = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const sel = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
  const links = [...document.querySelectorAll('a[href]')].map((a) => a.href).filter((h) => h.startsWith(location.origin)).map((h) => h.split('#')[0]);
  const imgs = [...document.images];
  const anchors = [...document.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href')).filter((h) => h.length > 1 && !document.getElementById(decodeURIComponent(h.slice(1))));
  const wide = [...document.querySelectorAll('body *')].filter((el) => vis(el) && el.getBoundingClientRect().right > innerWidth + 1).slice(0, 5).map(sel);
  return {
    title: document.title,
    viewportMeta: !!document.querySelector('meta[name=viewport]'),
    height: Math.ceil(scrollY + Math.max(0, ...[document.body, ...document.querySelectorAll('body *')].slice(0, 3000).filter(Boolean).map((el) => el.getBoundingClientRect().bottom))),
    overflowX: document.documentElement.scrollWidth > innerWidth + 1,
    wide,
    links: [...new Set(links)].slice(0, 40),
    brokenImages: imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.currentSrc || i.src).slice(0, 8),
    imagesNoAlt: imgs.filter((i) => !i.hasAttribute('alt')).length,
    deadAnchors: [...new Set(anchors)].slice(0, 8),
    emptyLinks: [...document.querySelectorAll('a')].filter((a) => vis(a) && !a.innerText.trim() && !a.getAttribute('aria-label') && !a.querySelector('img[alt]')).length,
    text: document.body ? document.body.innerText.length : 0,
  };
})()`;

// Visible buttons that do not submit a form; kept on window so each can be clicked in turn.
const BUTTONS = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const els = [...document.querySelectorAll('button, [role=button], summary, input[type=button]')].filter((el) => vis(el) && !(el.form && (el.type || 'submit') === 'submit'));
  window.__kb = els.slice(0, 6);
  return window.__kb.map((el) => (el.innerText || el.getAttribute('aria-label') || el.title || el.value || el.tagName).trim().replace(/\\s+/g, ' ').slice(0, 40));
})()`;

const CLICK = (i) => `(async () => {
  const el = (window.__kb || [])[${i}];
  if (!el || !el.isConnected) return { skip: true };
  el.scrollIntoView({ block: 'center' });
  await new Promise((r) => setTimeout(r, 150));
  let muts = 0;
  const mo = new MutationObserver((l) => { muts += l.length; });
  mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  const href = location.href, y = scrollY;
  el.click();
  await new Promise((r) => setTimeout(r, 600));
  mo.disconnect();
  return { changed: muts > 0 || location.href !== href || Math.abs(scrollY - y) > 2, navigated: location.href !== href };
})()`;

// Scroll down and back so scroll-triggered content (fade-in on scroll) is shown in the screenshot.
const REVEAL = `(async () => {
  const step = innerHeight * 0.8;
  for (let i = 0; i < 20 && scrollY + innerHeight < document.documentElement.scrollHeight; i++) { scrollBy(0, step); await new Promise((r) => setTimeout(r, 120)); }
  await new Promise((r) => setTimeout(r, 300));
  scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 300));
})()`;

const pageName = (url, base) => {
  const p = new URL(url).pathname.replace(/\/index\.html?$/i, '/');
  return p === '/' || url === base ? 'home' : p.replace(/^\/|\/$/g, '').replace(/\.html?$/i, '').replace(/[^\w-]+/g, '-').slice(0, 40) || 'page';
};

/**
 * Open `url`, walk up to `pages` pages at desktop width (the first two also on a phone),
 * click the buttons of the start page, collect JS errors and failed requests, and save
 * a screenshot per page and viewport into `outDir`.
 */
export async function inspectSite(url, { bin, outDir, pages = 4, pool, signal, log = () => {} }) {
  await fsp.mkdir(outDir, { recursive: true });
  const { cdp, close } = await launchBrowser(bin, { pool, signal });
  const report = { url, pages: [], shots: [] };
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: s } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (m, p, ms) => cdp.send(m, p, s, ms);
    await Promise.all(['Page.enable', 'Runtime.enable', 'Network.enable'].map((m) => send(m)));

    let current = null; // the page record that events are added to
    let clicking = null;
    const issue = (text) => current && current.problems.length < 20 && !current.problems.includes(text) && current.problems.push(text);
    const urls = new Map();
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: d = {} }) => {
      const msg = (d.exception?.description || d.text || 'error').split('\n')[0];
      issue(`${clicking ? `clicking "${clicking}" threw` : 'JS error'}: ${msg}${d.url ? ` (${d.url.split('/').pop() || 'inline'}:${(d.lineNumber ?? 0) + 1})` : ''}`);
    });
    cdp.on('Runtime.consoleAPICalled', ({ type, args = [] }) => {
      if (type === 'error' || type === 'assert') issue(`console.error: ${args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200)}`);
    });
    cdp.on('Network.requestWillBeSent', ({ requestId, request }) => urls.set(requestId, request.url));
    cdp.on('Network.responseReceived', ({ response, type }) => {
      if (response.status >= 400 && !/favicon\.ico$/.test(response.url)) issue(`${type === 'Document' ? 'page' : 'request'} returned ${response.status}: ${response.url.replace(url, '') || '/'}`);
    });
    cdp.on('Network.loadingFailed', ({ requestId, errorText, canceled }) => {
      const u = urls.get(requestId) || '';
      if (!canceled && !/favicon\.ico$/.test(u)) issue(`request failed (${errorText}): ${u.replace(url, '') || '/'}`);
    });

    const visit = async (target, vp, name, { clicks = false } = {}) => {
      if (signal?.aborted) throw new Error('aborted');
      const v = VIEWPORTS[vp];
      current = { url: target, path: new URL(target).pathname, viewport: vp, problems: [] };
      report.pages.push(current);
      await send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: v.deviceScaleFactor, mobile: v.mobile });
      const loaded = cdp.once('Page.loadEventFired', 20_000);
      const nav = await send('Page.navigate', { url: target });
      if (nav.errorText) issue(`could not open: ${nav.errorText}`);
      await loaded;
      await sleep(800);
      const probe = (await send('Runtime.evaluate', { expression: PROBE, returnByValue: true })).result?.value || {};
      current.title = probe.title;
      if (probe.overflowX) issue(`horizontal scrolling: the page is wider than the ${vp} screen${probe.wide?.length ? ` (${probe.wide.join(', ')})` : ''}`);
      for (const src of probe.brokenImages || []) issue(`broken image: ${src.replace(url, '')}`);
      if (probe.imagesNoAlt) issue(`${probe.imagesNoAlt} image(s) without alt text`);
      for (const a of probe.deadAnchors || []) issue(`link ${a} points to no element`);
      if (probe.emptyLinks) issue(`${probe.emptyLinks} link(s) without text or aria-label`);
      if (vp === 'mobile' && !probe.viewportMeta) issue('no <meta name="viewport">: phones show the desktop layout zoomed out');
      if (probe.text < 20) issue('the page shows almost no text (blank page?)');

      await send('Runtime.evaluate', { expression: REVEAL, awaitPromise: true }, 15_000).catch(() => {});
      const height = Math.min(Math.max(probe.height || v.height, v.height), v.maxHeight);
      const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 80, captureBeyondViewport: true, clip: { x: 0, y: 0, width: v.width, height, scale: 1 } }, 45_000);
      const file = path.join(outDir, `${String(report.shots.length + 1).padStart(2, '0')}-${name}-${vp}.jpg`);
      await fsp.writeFile(file, Buffer.from(shot.data, 'base64'));
      report.shots.push({ file, page: current.path, viewport: vp, width: v.width });
      current.shot = file;

      if (clicks) {
        const labels = (await send('Runtime.evaluate', { expression: BUTTONS, returnByValue: true })).result?.value || [];
        current.clicked = [];
        for (let i = 0; i < labels.length; i++) {
          clicking = labels[i] || `button ${i + 1}`;
          const before = current.problems.length;
          const r = (await send('Runtime.evaluate', { expression: CLICK(i), awaitPromise: true, returnByValue: true }, 10_000).catch(() => null))?.result?.value;
          await sleep(100);
          if (r && !r.skip) {
            current.clicked.push(clicking);
            if (!r.changed && current.problems.length === before) issue(`button "${clicking}" did nothing when clicked`);
          }
          clicking = null;
          if (r?.navigated) {
            const again = cdp.once('Page.loadEventFired', 15_000);
            await send('Page.navigate', { url: target });
            await again;
            await sleep(400);
            await send('Runtime.evaluate', { expression: BUTTONS, returnByValue: true });
          }
        }
      }
      return probe;
    };

    const home = await visit(url, 'desktop', 'home', { clicks: true });
    const others = (home.links || []).filter((l) => l !== url && l !== `${url}/` && !/\.(pdf|png|jpe?g|gif|svg|zip|webp|mp4)$/i.test(l)).slice(0, Math.max(0, pages - 1));
    for (const link of others) await visit(link, 'desktop', pageName(link, url));
    await visit(url, 'mobile', 'home', { clicks: true });
    if (others[0]) await visit(others[0], 'mobile', pageName(others[0], url));
    log(`${report.pages.length} page views, ${report.shots.length} screenshots`);
    return report;
  } finally {
    await close();
  }
}

/** The report as text for the agents (and the log). */
export function formatReport(report, { root } = {}) {
  const rel = (f) => (root ? path.relative(root, f).split(path.sep).join('/') : f);
  const problems = report.pages.flatMap((p) => p.problems.map((x) => `- [${p.viewport} ${p.path}] ${x}`));
  const clicked = report.pages.filter((p) => p.clicked?.length).map((p) => `- [${p.viewport} ${p.path}] clicked: ${p.clicked.map((c) => `"${c}"`).join(', ')}`);
  return [
    `Site: ${report.url}`,
    `Visited: ${report.pages.map((p) => `${p.path} (${p.viewport}${p.title ? `, "${p.title}"` : ''})`).join('; ')}`,
    clicked.length ? `Buttons tried:\n${clicked.join('\n')}` : null,
    problems.length ? `Problems found automatically:\n${problems.join('\n')}` : 'No problems found automatically (no JS errors, failed requests, dead buttons or overflow).',
    `Screenshots:\n${report.shots.map((s) => `- ${rel(s.file)} (${s.viewport} ${s.width}px, ${s.page})`).join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Problem count across all pages. */
export const problemCount = (report) => report.pages.reduce((n, p) => n + p.problems.length, 0);
