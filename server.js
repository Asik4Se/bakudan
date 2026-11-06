'use strict';
/*
 * BAKUDAN — 爆弾回しオンラインゲーム
 * 依存パッケージなし（Node.js 標準モジュールのみ）。WebSocket も自前実装。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---- ゲーム定数 ----
const MAX_PLAYERS = 18;        // 最大人数
const MIN_PLAYERS = 4;         // 最低人数（足りない分は NPC）
const HOLD_MAX = 5000;         // 爆弾を持てる最大時間
const MIN_HOLD = 300;          // 受け取ってから回せるまでの最短時間（連打防止）
const FUSE_MIN = 30000;        // 爆発まで 最短 30 秒
const FUSE_MAX = 60000;        // 爆発まで 最長 60 秒
const REVEAL_MS = 5000;        // 最初の 5 秒だけカウントダウン表示
const BLAST_MIN_ALIVE = 5;     // 生存 5 人以上で爆風（ひとつ前の手番も脱落）
const PRE_ROUND_MS = 3000;     // ラウンド開始前の待ち
const BOOM_PAUSE_MS = 4500;    // 爆発演出の時間
const LOBBY_GRACE_MS = 20000;  // ロビーで切断した人を残しておく時間
const HOST_GRACE_MS = 15000;   // ホストが切断したら委譲するまでの時間
const ROOM_TTL_MS = 10 * 60 * 1000;
const TICK_MS = 40;

const NPC_NAMES = [
  'ボム太', 'ニトロ子', 'カチカチ丸', 'ドカン部長', '導火線ミキ', 'ヒバナ',
  'バクレツ先生', 'ポップ', 'タイマー田中', 'ヒューズ', 'マッチ棒', 'ハナビ',
  '信管くん', 'ズドン', 'チクタク', 'ボンバー松', 'カヤク姫', 'パチパチ',
];

// ---------------------------------------------------------------- HTTP
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { res.writeHead(400); return res.end(); }
  if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (p === '/') p = '/index.html';
  const fp = path.join(PUBLIC_DIR, path.normalize(p));
  if (!fp.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// ---------------------------------------------------------------- WebSocket (RFC 6455 最小実装)
const allConns = new Set();

class Conn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.open = true;
    this.alive = true;
    this.room = null;
    this.humanId = null;
    this.onmessage = null;
    this.onclose = null;
    socket.on('data', (d) => this._data(d));
    socket.on('close', () => this._closed());
    socket.on('end', () => this._closed());
    socket.on('error', () => this._closed());
  }
  _data(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = this.buf.readUInt32BE(2) * 2 ** 32 + this.buf.readUInt32BE(6); off = 10;
      }
      if (len > 1 << 20) { this.close(); return; }
      const mlen = masked ? 4 : 0;
      if (this.buf.length < off + mlen + len) return;
      let payload = Buffer.from(this.buf.subarray(off + mlen, off + mlen + len));
      if (masked) {
        const m0 = this.buf[off], m1 = this.buf[off + 1], m2 = this.buf[off + 2], m3 = this.buf[off + 3];
        const mk = [m0, m1, m2, m3];
        for (let i = 0; i < payload.length; i++) payload[i] ^= mk[i & 3];
      }
      this.buf = this.buf.subarray(off + mlen + len);
      this.alive = true;
      if (op === 0x8) { this.close(); return; }
      if (op === 0x9) { this._send(0xA, payload); continue; }
      if (op === 0xA) continue;
      if (op === 0x1 || op === 0x2) {
        if (fin) this._msg(payload); else this.frag = [payload];
        continue;
      }
      if (op === 0x0 && this.frag) {
        this.frag.push(payload);
        if (fin) { const p = Buffer.concat(this.frag); this.frag = null; this._msg(p); }
      }
    }
  }
  _msg(p) {
    let m;
    try { m = JSON.parse(p.toString('utf8')); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (this.onmessage) {
      try { this.onmessage(m); } catch (e) { console.error(e); }
    }
  }
  _send(op, payload) {
    if (!this.open) return;
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | op; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | op; header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
    try { this.socket.write(Buffer.concat([header, payload])); } catch { /* ignore */ }
  }
  send(obj) { this._send(0x1, Buffer.from(JSON.stringify(obj))); }
  ping() { this._send(0x9, Buffer.alloc(0)); }
  close() {
    if (!this.open) return;
    this._send(0x8, Buffer.alloc(0));
    this.open = false;
    try { this.socket.end(); } catch { /* ignore */ }
    this._closed();
  }
  _closed() {
    if (this._done) return;
    this._done = true;
    this.open = false;
    allConns.delete(this);
    try { this.socket.destroy(); } catch { /* ignore */ }
    if (this.onclose) {
      try { this.onclose(); } catch (e) { console.error(e); }
    }
  }
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if ((req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.setNoDelay(true);
  const conn = new Conn(socket);
  allConns.add(conn);
  conn.onmessage = (m) => handleMsg(conn, m);
  conn.onclose = () => handleClose(conn);
});

// 生存確認（Render などのプロキシでアイドル切断されないように）
setInterval(() => {
  for (const c of allConns) {
    if (!c.alive) { c.close(); continue; }
    c.alive = false;
    c.ping();
  }
}, 20000);

// ---------------------------------------------------------------- 部屋
const rooms = new Map();
let uid = 1;
const newId = (p) => p + (uid++).toString(36);

function genCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += A[crypto.randomInt(A.length)];
    if (!rooms.has(c)) return c;
  }
}
function cleanName(n) {
  n = String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
  return n || 'プレイヤー';
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function createRoom() {
  const room = {
    code: genCode(), hostId: null, phase: 'lobby',
    humans: [], npcTarget: 0, game: null, emptySince: 0, dirty: false,
  };
  rooms.set(room.code, room);
  return room;
}
const humanById = (room, id) => room.humans.find((h) => h.id === id);
const lobbyHumans = (room) => room.humans.filter((h) => !h.spectate && h.connected);
const playerSlotsUsed = (room) => room.humans.filter((h) => !h.spectate).length;

// ロビーでの NPC 数：ホスト指定数と「4人に足りない分」の大きい方（合計18人まで）
function npcCount(room) {
  const n = lobbyHumans(room).length;
  return Math.max(0, Math.min(Math.max(room.npcTarget, MIN_PLAYERS - n), MAX_PLAYERS - n));
}

// ---------------------------------------------------------------- ゲーム進行
function aliveIdx(g) {
  const r = [];
  g.players.forEach((p, i) => { if (p.alive) r.push(i); });
  return r;
}
function nextAlive(g, i, dir = 1) {
  const n = g.players.length;
  for (let k = 1; k <= n; k++) {
    const j = (((i + dir * k) % n) + n) % n;
    if (g.players[j].alive) return j;
  }
  return -1;
}
function isAuto(room, p) {
  if (p.isNpc) return true;
  const h = humanById(room, p.id);
  return !h || !h.connected;
}

function startGame(room) {
  const humans = lobbyHumans(room);
  const nNpc = npcCount(room);
  const players = humans.map((h) => ({ id: h.id, name: h.name, isNpc: false, alive: true, skew: 1 }));
  for (let i = 0; i < nNpc; i++) {
    players.push({ id: newId('n'), name: NPC_NAMES[i % NPC_NAMES.length], isNpc: true, alive: true, skew: 1 });
  }
  shuffle(players);
  room.game = {
    players, round: 1,
    holder: -1, prev: -1, holdStart: 0, startAt: 0, fuseMs: 0,
    nextAt: Date.now() + PRE_ROUND_MS, npcPassAt: 0,
    startIdx: crypto.randomInt(players.length),
    lastBoom: null, out: [], winnerId: null, passes: 0,
  };
  room.phase = 'pre';
  room.dirty = true;
}

function beginRound(room, now) {
  const g = room.game;
  g.fuseMs = FUSE_MIN + crypto.randomInt(FUSE_MAX - FUSE_MIN + 1);
  g.startAt = now;
  let s = g.startIdx;
  if (s < 0 || !g.players[s].alive) s = nextAlive(g, Math.max(0, s), 1);
  g.holder = s;
  g.prev = -1;
  g.holdStart = now;
  g.npcPassAt = 0;
  g.passes = 0;
  // NPC ごとの体内時計のズレ（±15%）
  for (const p of g.players) p.skew = 0.85 + Math.random() * 0.3;
  room.phase = 'live';
  room.dirty = true;
}

function passBomb(room, now) {
  const g = room.game;
  const nx = nextAlive(g, g.holder, 1);
  if (nx < 0 || nx === g.holder) return;
  g.prev = g.holder;
  g.holder = nx;
  g.holdStart = now;
  g.npcPassAt = 0;
  g.passes++;
  room.dirty = true;
}

function explode(room, now) {
  const g = room.game;
  const aliveCount = aliveIdx(g).length;
  const victims = [g.holder];
  const blast = aliveCount >= BLAST_MIN_ALIVE;
  if (blast) {
    // ひとつ前の手番（反時計回りに隣の生存者 = 直前に爆弾を持っていた人）
    const pv = nextAlive(g, g.holder, -1);
    if (pv >= 0 && pv !== g.holder) victims.push(pv);
  }
  for (const v of victims) g.players[v].alive = false;
  g.lastBoom = {
    seq: uid++, round: g.round, holderId: g.players[g.holder].id,
    victims: victims.map((v) => g.players[v].id),
    fuseMs: g.fuseMs, blast, passes: g.passes,
  };
  g.out.push({ round: g.round, ids: victims.map((v) => g.players[v].id) });
  g.startIdx = nextAlive(g, g.holder, 1);
  g.holder = -1;
  room.phase = 'boom';
  g.nextAt = now + BOOM_PAUSE_MS;
  room.dirty = true;
}

// NPC（と切断中プレイヤーの代打）が何ミリ秒持つか
function npcHoldMs(room, p, now) {
  const g = room.game;
  const est = (now - g.startAt) * p.skew; // NPC の頭の中の経過時間
  let ms;
  if (est < 20000) ms = 1200 + Math.random() * 3300;      // 序盤：のんびり
  else if (est < 27000) ms = 700 + Math.random() * 2800;  // 30秒が近い：少し急ぐ
  else ms = 350 + Math.random() * 2400;                   // いつ爆発してもおかしくない
  if (Math.random() < 0.06) ms = HOLD_MAX + 200;           // たまにゲージ切れまで持つ
  return Math.max(MIN_HOLD, ms);
}

function tickRoom(room, now) {
  // ロビー：切断したままの人を削除
  if (room.phase === 'lobby') {
    const before = room.humans.length;
    room.humans = room.humans.filter((h) => h.connected || now - h.lastSeen < LOBBY_GRACE_MS);
    if (room.humans.length !== before) room.dirty = true;
  }
  // ホスト委譲
  const host = humanById(room, room.hostId);
  if (!host || (!host.connected && now - host.lastSeen > HOST_GRACE_MS)) {
    const nh = room.humans.find((h) => h.connected);
    if (nh && nh.id !== room.hostId) { room.hostId = nh.id; room.dirty = true; }
  }
  // 誰もいない部屋は削除
  if (!room.humans.some((h) => h.connected)) {
    if (!room.emptySince) room.emptySince = now;
    if (now - room.emptySince > ROOM_TTL_MS) { rooms.delete(room.code); return; }
  } else room.emptySince = 0;

  const g = room.game;
  switch (room.phase) {
    case 'pre':
      if (now >= g.nextAt) beginRound(room, now);
      break;
    case 'live': {
      if (now >= g.startAt + g.fuseMs) { explode(room, now); break; }
      if (now >= g.holdStart + HOLD_MAX) { passBomb(room, now); break; } // ゲージ切れ → 自動で次へ
      const holder = g.players[g.holder];
      if (isAuto(room, holder)) {
        if (!g.npcPassAt) g.npcPassAt = Math.max(g.holdStart + npcHoldMs(room, holder, now), now + 250);
        if (now >= g.npcPassAt) passBomb(room, now);
      } else {
        g.npcPassAt = 0;
      }
      break;
    }
    case 'boom':
      if (now >= g.nextAt) {
        const alive = aliveIdx(g);
        if (alive.length <= 1) {
          room.phase = 'over';
          g.winnerId = alive.length ? g.players[alive[0]].id : null;
        } else {
          room.phase = 'pre';
          g.round++;
          g.nextAt = now + PRE_ROUND_MS;
        }
        room.dirty = true;
      }
      break;
    default:
      break;
  }
  if (room.dirty) broadcast(room);
}

setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    try { tickRoom(room, now); } catch (e) { console.error(e); }
  }
}, TICK_MS);

// ---------------------------------------------------------------- 状態配信
function buildState(room) {
  const now = Date.now();
  const st = {
    t: 'state', code: room.code, phase: room.phase, hostId: room.hostId, now,
    limits: {
      min: MIN_PLAYERS, max: MAX_PLAYERS, holdMax: HOLD_MAX, minHold: MIN_HOLD,
      revealMs: REVEAL_MS, blastMin: BLAST_MIN_ALIVE, fuseMin: FUSE_MIN, fuseMax: FUSE_MAX,
    },
  };
  const n = npcCount(room);
  st.lobby = {
    humans: room.humans.map((h) => ({ id: h.id, name: h.name, connected: h.connected, spectate: h.spectate })),
    npcs: NPC_NAMES.slice(0, n),
    minNpc: Math.max(0, MIN_PLAYERS - lobbyHumans(room).length),
  };
  const g = room.game;
  if (g && room.phase !== 'lobby') {
    const gs = {
      round: g.round,
      players: g.players.map((p) => ({
        id: p.id, name: p.name, isNpc: p.isNpc, alive: p.alive,
        auto: !p.isNpc && isAuto(room, p),
      })),
      holderId: room.phase === 'live' && g.holder >= 0 ? g.players[g.holder].id : null,
      prevId: room.phase === 'live' && g.prev >= 0 ? g.players[g.prev].id : null,
      holdStart: g.holdStart, startAt: g.startAt, nextAt: g.nextAt,
      lastBoom: g.lastBoom, out: g.out, winnerId: g.winnerId,
    };
    if (room.phase === 'pre') {
      let s = g.startIdx;
      if (s < 0 || !g.players[s].alive) s = nextAlive(g, Math.max(0, s), 1);
      gs.startId = s >= 0 ? g.players[s].id : null;
    }
    // 爆発までの時間は「最初の5秒」の間だけ送る
    if (room.phase === 'live' && now < g.startAt + REVEAL_MS) gs.fuseMs = g.fuseMs;
    st.game = gs;
  }
  return st;
}

function broadcast(room) {
  room.dirty = false;
  const st = buildState(room);
  for (const h of room.humans) {
    if (h.conn) { st.you = h.id; h.conn.send(st); }
  }
}

// ---------------------------------------------------------------- メッセージ処理
function attach(conn, room, h) {
  if (conn.room && (conn.room !== room || conn.humanId !== h.id)) detach(conn, false);
  if (h.conn && h.conn !== conn) {
    const old = h.conn;
    old.room = null; old.humanId = null;
    old.send({ t: 'kicked', msg: '別の画面からこの部屋に接続されました' });
    old.close();
  }
  h.conn = conn;
  h.connected = true;
  h.lastSeen = Date.now();
  conn.room = room;
  conn.humanId = h.id;
  conn.send({ t: 'joined', code: room.code, you: h.id });
  room.dirty = true;
}

function detach(conn, explicitLeave) {
  const room = conn.room;
  if (!room) return;
  const h = humanById(room, conn.humanId);
  conn.room = null;
  conn.humanId = null;
  if (!h || h.conn !== conn) return;
  h.conn = null;
  h.connected = false;
  h.lastSeen = Date.now();
  if (explicitLeave) {
    room.humans = room.humans.filter((x) => x !== h);
    if (room.hostId === h.id) {
      const nh = room.humans.find((x) => x.connected) || room.humans[0];
      room.hostId = nh ? nh.id : null;
    }
  }
  room.dirty = true;
}

function handleClose(conn) {
  const room = conn.room;
  detach(conn, false);
  if (room && room.dirty) broadcast(room);
}

function handleMsg(conn, m) {
  if (m.t === 'ping') { conn.send({ t: 'pong', c: m.c, s: Date.now() }); return; }

  if (m.t === 'create') {
    const room = createRoom();
    const h = {
      id: newId('h'), token: String(m.token || '').slice(0, 64), name: cleanName(m.name),
      spectate: !!m.spectate, connected: true, conn: null, lastSeen: Date.now(),
    };
    room.humans.push(h);
    room.hostId = h.id;
    attach(conn, room, h);
    broadcast(room);
    return;
  }

  if (m.t === 'join') {
    const code = String(m.code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) { conn.send({ t: 'error', code: 'noroom', msg: '部屋が見つかりません' }); return; }
    const token = String(m.token || '').slice(0, 64);
    let h = token ? room.humans.find((x) => x.token === token) : null;
    if (h) {
      if (m.name && !m.rejoin && room.phase === 'lobby') h.name = cleanName(m.name);
    } else {
      if (room.humans.length >= 60) { conn.send({ t: 'error', msg: '部屋が満員です' }); return; }
      let spectate = !!m.spectate;
      if (!spectate && playerSlotsUsed(room) >= MAX_PLAYERS) {
        spectate = true;
        conn.send({ t: 'notice', msg: 'プレイヤー枠が満員のため観戦で入りました' });
      }
      h = {
        id: newId('h'), token, name: cleanName(m.name), spectate,
        connected: true, conn: null, lastSeen: Date.now(),
      };
      room.humans.push(h);
      if (room.phase !== 'lobby' && !spectate) {
        conn.send({ t: 'notice', msg: 'ゲーム中のため、次のゲームから参加になります' });
      }
      if (!humanById(room, room.hostId)) room.hostId = h.id;
    }
    attach(conn, room, h);
    broadcast(room);
    return;
  }

  const room = conn.room;
  const h = room && humanById(room, conn.humanId);
  if (!h) return;
  const isHost = room.hostId === h.id;
  const now = Date.now();

  switch (m.t) {
    case 'leave':
      detach(conn, true);
      conn.send({ t: 'left' });
      break;
    case 'spectate':
      if (room.phase !== 'lobby') break;
      if (!m.on && h.spectate && playerSlotsUsed(room) >= MAX_PLAYERS) {
        conn.send({ t: 'error', msg: 'プレイヤー枠が満員です' });
        break;
      }
      h.spectate = !!m.on;
      room.dirty = true;
      break;
    case 'npc': {
      if (!isHost || room.phase !== 'lobby') break;
      const cur = npcCount(room);
      const n = lobbyHumans(room).length;
      room.npcTarget = m.d > 0 ? Math.min(cur + 1, MAX_PLAYERS - n) : Math.max(cur - 1, 0);
      room.dirty = true;
      break;
    }
    case 'start':
      if (!isHost || (room.phase !== 'lobby' && room.phase !== 'over')) break;
      if (lobbyHumans(room).length + npcCount(room) < MIN_PLAYERS) break;
      startGame(room);
      break;
    case 'tolobby':
      if (!isHost || room.phase === 'lobby') break;
      room.phase = 'lobby';
      room.game = null;
      room.dirty = true;
      break;
    case 'pass': {
      if (room.phase !== 'live') break;
      const g = room.game;
      if (g.holder < 0 || g.players[g.holder].id !== h.id) break;
      if (now - g.holdStart < MIN_HOLD) break;
      if (now >= g.startAt + g.fuseMs) break; // 爆発の方が先
      passBomb(room, now);
      break;
    }
    default:
      break;
  }
  if (room.dirty && rooms.has(room.code)) broadcast(room);
}

server.listen(PORT, () => {
  console.log(`BAKUDAN server listening on :${PORT}`);
});
