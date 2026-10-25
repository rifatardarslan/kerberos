import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Telegram } from 'telegraf';
import { kerberosHome } from '../config/config.js';

/*
 * One bot token allows a single getUpdates poller (a second one gets 409), but any
 * number of senders. So every Kerberos with RC on joins a local "hub": the first one
 * to bind the IPC address polls Telegram and forwards each update, as NDJSON, to the
 * process that owns the update's topic (message_thread_id). Sending stays per process.
 * When the hub exits, the others race to bind the address again (jittered).
 * In topic mode the hub also keeps a fixed "🐺 Kerberos" lobby topic.
 */

const tokenHash = (token) => createHash('sha1').update(String(token)).digest('hex').slice(0, 8);

export function hubAddress(token, home = kerberosHome()) {
  const h = tokenHash(token);
  return process.platform === 'win32' ? `\\\\.\\pipe\\kerberos-tg-${h}` : path.join(home, `tg-${h}.sock`);
}

/**
 * threadId → { sessionId, root, title, name }: finds a folder's topic again and lets the
 * hub answer in topics of closed sessions. The lobby topic is kept under "lobby".
 */
export function topicsFile(token, home = kerberosHome()) {
  return path.join(home, `telegram-topics-${tokenHash(token)}.json`);
}

export function readTopics(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function rememberTopic(file, threadId, info) {
  const all = readTopics(file);
  all[threadId] = { ...all[threadId], ...info, at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, file);
}

const samePath = (a, b) => {
  const norm = (p) => path.resolve(String(p || ''));
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

/** Topics used for `root` so far, most recent first. */
export function projectTopics(file, root) {
  return Object.entries(readTopics(file))
    .filter(([id, t]) => /^\d+$/.test(id) && samePath(t.root, root))
    .map(([id, t]) => ({ ...t, threadId: Number(id) }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

function forgetTopic(file, key) {
  const all = readTopics(file);
  delete all[key];
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
}

const LOBBY_NAME = '🐺 Kerberos';
const THREAD_GONE = /thread not found|topic.*(closed|deleted|not found)/i;

/** Topic of an update: messages carry it directly, button presses on the message they belong to. */
export function threadOf(update) {
  const msg = update.message || update.edited_message || update.callback_query?.message;
  return msg?.message_thread_id ?? null;
}

export function senderOf(update) {
  return (update.message || update.edited_message || update.callback_query)?.from?.id ?? null;
}

const LOBBY_COMMAND = /^\/(sessions|status|start|help)(@\w+)?\b/;
const SESSIONS_COMMAND = /^\/sessions(@\w+)?\b/;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const jitter = () => 100 + Math.floor(Math.random() * 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Write/read newline-delimited JSON over a socket. */
function ndjson(socket, onMessage) {
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        // ignore malformed lines
      }
    }
  });
  return (msg) => !socket.destroyed && socket.write(`${JSON.stringify(msg)}\n`);
}

/** Long-polls getUpdates; tolerates the 409 of a hub that has not let go yet. */
class Poller {
  constructor(api, onUpdate, log) {
    this.api = api;
    this.onUpdate = onUpdate;
    this.log = log;
    this.offset = 0;
    this.running = false;
    this.ctrl = null;
  }

  async start({ dropPending }) {
    this.running = true;
    await this.api.callApi('deleteWebhook', { drop_pending_updates: Boolean(dropPending) }).catch(() => {});
    this.loop();
  }

  async loop() {
    let conflicts = 0;
    while (this.running) {
      this.ctrl = new AbortController();
      try {
        const updates = await this.api.callApi('getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, { signal: this.ctrl.signal });
        conflicts = 0;
        for (const u of updates) {
          this.offset = u.update_id + 1;
          if (this.running) this.onUpdate(u);
        }
      } catch (err) {
        if (!this.running) break;
        const code = err.code ?? err.response?.error_code;
        if (code === 409 && ++conflicts < 30) await sleep(1000);
        else if (code === 401) {
          this.log(`Telegram token reddedildi: ${err.message}`, 'error');
          break;
        } else {
          this.log(`Telegram polling hatası: ${err.message}`, 'warn');
          await sleep(3000);
        }
      }
    }
  }

  /** Stop and confirm what was delivered, so the next hub does not see it again. */
  async stop() {
    this.running = false;
    this.ctrl?.abort();
    if (this.offset) await this.api.callApi('getUpdates', { offset: this.offset, timeout: 0, limit: 1 }).catch(() => {});
  }
}

/**
 * A bridge's membership in the hub. `join(info)` makes this process the hub or a
 * client; updates for this member arrive as 'update' events either way.
 * info: { sessionId, threadId, root, title }
 */
export class HubLink extends EventEmitter {
  constructor({ token, allowedUserId, topics, address = hubAddress(token), topicsPath = topicsFile(token), api = new Telegram(token), log = () => {} }) {
    super();
    Object.assign(this, { token, allowedUserId, topics, address, topicsPath, api, log });
    this.role = null;
    this.info = {};
    this.closed = true;
    this.server = null;
    this.socket = null;
    this.members = new Map(); // hub only: id → { info, send }
    this.nextId = 1;
    this.pending = new Map(); // client only: request id → resolve
  }

  /** Topics other running Kerberos processes are using right now. */
  busyThreads() {
    if (this.role === 'hub') return Promise.resolve([...this.members].filter(([id]) => id !== 0).map(([, m]) => m.info.threadId).filter(Boolean));
    if (!this.send) return Promise.resolve([]);
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => (this.pending.delete(id), resolve([])), 1500);
      this.pending.set(id, (threads) => (clearTimeout(timer), resolve(threads)));
      this.send({ type: 'who', id });
    });
  }

  async join(info) {
    this.info = { ...info, pid: process.pid };
    this.closed = false;
    await this.#elect(true);
    return this.role;
  }

  /** Update this member's routing data (new session, topic or title). */
  register(info) {
    Object.assign(this.info, info);
    if (this.role === 'hub') this.members.get(0).info = this.info;
    else this.send?.({ type: 'hello', info: this.info });
  }

  async leave() {
    this.closed = true;
    const role = this.role;
    this.role = null;
    if (role === 'hub') {
      await this.poller.stop();
      for (const s of this.sockets || []) s.destroy();
      await new Promise((r) => this.server.close(() => r()));
      this.server = null;
    } else if (this.socket) {
      this.socket.end();
      this.socket.destroy();
      this.socket = null;
    }
  }

  async #elect(first) {
    for (let attempt = 0; !this.closed && attempt < 20; attempt++) {
      if (await this.#listen(first && attempt === 0)) return;
      if (await this.#connect()) return;
      await sleep(jitter());
    }
    if (!this.closed) throw new Error('Telegram hub’ına bağlanılamadı');
  }

  #listen(fresh) {
    if (process.platform !== 'win32') fs.mkdirSync(path.dirname(this.address), { recursive: true });
    return new Promise((resolve) => {
      const server = net.createServer((socket) => this.#accept(socket));
      server.once('error', async (err) => {
        // A dead hub can leave its Unix socket file behind.
        if (err.code === 'EADDRINUSE' && process.platform !== 'win32' && !(await this.#alive())) {
          fs.rmSync(this.address, { force: true });
          return resolve(this.#listen(fresh));
        }
        resolve(false);
      });
      server.listen(this.address, async () => {
        server.removeAllListeners('error');
        server.on('error', (err) => this.log(`Telegram hub hatası: ${err.message}`, 'warn'));
        this.server = server;
        this.sockets = new Set();
        this.role = 'hub';
        this.members = new Map([[0, { info: this.info, send: (msg) => msg.type === 'update' && this.emit('update', msg.update) }]]);
        this.poller = new Poller(this.api, (u) => this.route(u), this.log);
        await this.poller.start({ dropPending: fresh });
        if (this.topics) this.lobbyReady = this.#ensureLobby().catch((err) => this.log(`Telegram lobi konusu açılamadı: ${err.message}`, 'warn'));
        this.emit('role', 'hub');
        resolve(true);
      });
    });
  }

  #alive() {
    return new Promise((resolve) => {
      const s = net.connect(this.address, () => (s.destroy(), resolve(true)));
      s.once('error', () => resolve(false));
    });
  }

  #connect() {
    return new Promise((resolve) => {
      const socket = net.connect(this.address);
      socket.once('error', () => resolve(false));
      socket.once('connect', () => {
        socket.removeAllListeners('error');
        socket.on('error', () => {});
        this.socket = socket;
        this.role = 'client';
        this.send = ndjson(socket, (msg) => {
          if (msg.type === 'update') this.emit('update', msg.update);
          else if (msg.type === 'members') this.pending.get(msg.id)?.(msg.threads || []);
        });
        this.send({ type: 'hello', info: this.info });
        socket.once('close', () => {
          if (this.socket !== socket) return;
          this.socket = null;
          this.send = null;
          this.role = null;
          if (this.closed) return;
          // Hub went away: take over or follow whoever does ('role' is emitted again).
          sleep(jitter())
            .then(() => this.#elect(false))
            .catch((err) => this.log(err.message, 'error'));
        });
        this.emit('role', 'client');
        resolve(true);
      });
    });
  }

  #accept(socket) {
    const id = this.nextId++;
    this.sockets.add(socket);
    const send = ndjson(socket, (msg) => {
      if (msg.type === 'hello') this.members.set(id, { info: msg.info, send });
      else if (msg.type === 'who') {
        const threads = [...this.members].filter(([mid]) => mid !== id).map(([, m]) => m.info.threadId).filter(Boolean);
        send({ type: 'members', id: msg.id, threads });
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      this.sockets.delete(socket);
      this.members.delete(id);
    });
  }

  // ------------------------------------------------------------------ hub side

  /** Deliver one update to the member owning its topic, or answer it here. */
  route(update) {
    if (senderOf(update) !== this.allowedUserId) return; // whitelist: silently dropped
    const thread = threadOf(update);
    const members = [...this.members.values()];
    if (!this.topics) {
      // No topic mode: one shared chat, the newest Kerberos listens.
      const latest = members.at(-1);
      return latest?.send({ type: 'update', update });
    }
    if (thread !== null) {
      // /sessions is about every Kerberos, so the hub answers it even inside a project topic.
      const owner = !SESSIONS_COMMAND.test(update.message?.text?.trim() || '') && members.find((m) => m.info.threadId === thread);
      if (owner) return owner.send({ type: 'update', update });
    }
    // In topic mode a message outside every topic opens a new topic of its own, so
    // there is no plain main chat: the lobby and topics no session owns answer here.
    const known = thread !== null && thread !== this.lobbyThread && readTopics(this.topicsPath)[thread];
    if (known && !LOBBY_COMMAND.test(update.message?.text?.trim() || '')) return this.#orphan(update, thread, known);
    return this.#lobby(update, thread);
  }

  #reply(update, text, thread) {
    if (update.callback_query) return this.api.callApi('answerCallbackQuery', { callback_query_id: update.callback_query.id, text: text.replace(/<[^>]+>/g, '').slice(0, 190) }).catch(() => {});
    return this.#say(text, thread);
  }

  #say(text, thread) {
    return this.api
      .callApi('sendMessage', { chat_id: this.allowedUserId, text, parse_mode: 'HTML', ...(thread !== null ? { message_thread_id: thread } : {}) })
      .catch(async (err) => {
        // The user deleted the lobby: open it again and say it there.
        if (thread !== null && thread === this.lobbyThread && THREAD_GONE.test(err.message)) {
          forgetTopic(this.topicsPath, 'lobby');
          await this.#ensureLobby();
          return this.#say(text, this.lobbyThread);
        }
        this.log(`Telegram gönderim hatası: ${err.message}`, 'warn');
      });
  }

  /** One fixed lobby topic, shared by every Kerberos using this bot. */
  async #ensureLobby() {
    const saved = readTopics(this.topicsPath).lobby?.threadId;
    if (saved) return (this.lobbyThread = saved);
    const topic = await this.api.callApi('createForumTopic', { chat_id: this.allowedUserId, name: LOBBY_NAME });
    this.lobbyThread = topic.message_thread_id;
    rememberTopic(this.topicsPath, 'lobby', { threadId: this.lobbyThread });
    await this.#say(
      '🐺 <b>Kerberos lobisi</b>\nHer proje klasörünün kendi konusu var (📁 klasör); görevleri oraya yazın.\nBurada: /sessions açık oturumlar.\nYeni proje için bilgisayarda o dizinde <code>kerberos --rc</code> açın.',
      this.lobbyThread,
    );
    return this.lobbyThread;
  }

  /** The topic of a session whose Kerberos is not running. */
  #orphan(update, thread, t) {
    const text = `💤 <b>Bu oturum şu an açık değil</b>\n📁 <code>${esc(t.root)}</code>\n${t.title ? `<i>${esc(t.title)}</i>\n` : ''}\nSürdürmek için bilgisayarda:\n<code>cd "${esc(t.root)}" &amp;&amp; kerberos --resume ${esc(String(t.sessionId).slice(0, 8))}</code>`;
    return this.#reply(update, text, thread);
  }

  /** Main chat or a topic no session owns: overview of running sessions. */
  #lobby(update, thread) {
    const text = update.message?.text?.trim() || '';
    const members = [...this.members.values()].map((m) => m.info);
    if (LOBBY_COMMAND.test(text)) {
      if (!members.length) return this.#reply(update, '🐺 Açık Kerberos oturumu yok.', thread);
      const names = members.map((m) => path.basename(m.root || '') || m.root);
      const rows = members.map((m, i) => {
        // Same folder name twice: add the parent folder to tell them apart.
        const twin = names.filter((n) => n === names[i]).length > 1 ? ` <i>(${esc(path.basename(path.dirname(m.root)))})</i>` : '';
        const title = m.title ? `\n     ${esc(m.title.length > 60 ? `${m.title.slice(0, 59)}…` : m.title)}` : '';
        return `📁 <b>${esc(names[i])}</b>${twin} · ${esc(m.status || '—')}${title}`;
      });
      return this.#reply(update, `🐺 <b>Açık oturumlar</b> (${members.length})\n\n${rows.join('\n')}\n\n<i>Görevleri ilgili 📁 konusuna yazın.</i>`, thread);
    }
    const where = thread === this.lobbyThread ? '' : `\nGenel komutlar için ${LOBBY_NAME} konusunu kullanın; bu konuyu silebilirsiniz.`;
    return this.#reply(
      update,
      `ℹ️ Görevleri projenin konusuna (📁 klasör) yazın. Yeni proje için bilgisayarda o dizinde <code>kerberos --rc</code> açın; kendi konusu oluşur.\nAçık oturumlar: /sessions${where}`,
      thread,
    );
  }
}
