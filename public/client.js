(() => {
'use strict';

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hueOf = (s) => { let h = 0; for (const ch of s) h = (h * 31 + ch.codePointAt(0)) >>> 0; return h % 360; };
const initial = (name) => [...String(name).trim()][0] || '?';

let TOKEN = store.get('bk_token');
if (!TOKEN) {
  TOKEN = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
  store.set('bk_token', TOKEN);
}

// 爆弾の絵を差し込む
const bombTpl = $('#bombSvg');
document.querySelectorAll('.bomb-art').forEach((el) => el.prepend(bombTpl.content.cloneNode(true)));

// ---------------------------------------------------------------- 音
// 音の設定（ローカルに保存）
const SND_DEFAULT = {
  master: { vol: 80, muted: false, vib: true },
  boom: { vol: 90, type: 'standard', len: 1.4, bass: 70, tone: 60 },
  pass: { vol: 60, wave: 'triangle', pitch: 420 },
  mine: { vol: 70, wave: 'square', pitch: 880 },
  count: { vol: 60 },
  win: { vol: 70 },
};
function loadSoundCfg() {
  const cfg = JSON.parse(JSON.stringify(SND_DEFAULT));
  try {
    const saved = JSON.parse(store.get('bk_sound', '{}'));
    for (const sec of Object.keys(cfg)) {
      if (saved[sec] && typeof saved[sec] === 'object') {
        for (const k of Object.keys(cfg[sec])) {
          if (typeof saved[sec][k] === typeof cfg[sec][k]) cfg[sec][k] = saved[sec][k];
        }
      }
    }
  } catch { /* ignore */ }
  if (store.get('bk_mute') === '1') { cfg.master.muted = true; store.del('bk_mute'); }
  return cfg;
}

const Sound = {
  ctx: null,
  bus: null,
  cfg: loadSoundCfg(),
  get muted() { return this.cfg.master.muted; },
  save() { store.set('bk_sound', JSON.stringify(this.cfg)); },
  init() {
    if (!this.ctx) {
      try {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        // 音割れ防止のコンプレッサー → 全体音量
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -10; comp.knee.value = 8; comp.ratio.value = 6;
        comp.attack.value = 0.003; comp.release.value = 0.2;
        this.bus = this.ctx.createGain();
        this.bus.connect(comp).connect(this.ctx.destination);
        this.applyMaster();
      } catch { this.ctx = null; }
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  },
  applyMaster() {
    if (!this.bus) return;
    const m = this.cfg.master;
    this.bus.gain.value = m.muted ? 0 : (m.vol / 100) ** 2;
  },
  // 各音の出力先（音量つき）。鳴らせないときは null
  out(vol) {
    this.init();
    if (!this.ctx || this.muted || vol <= 0) return null;
    const g = this.ctx.createGain();
    g.gain.value = (vol / 100) ** 2 * 1.6;
    g.connect(this.bus);
    return g;
  },
  tone(dest, f, d, type = 'square', v = 0.06, at = 0, f2 = 0) {
    if (!dest) return;
    const c = this.ctx, t = c.currentTime + at;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + d);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g).connect(dest);
    o.start(t); o.stop(t + d + 0.05);
  },
  // 減衰するノイズ（hold > 1 でサンプルホールド＝8bit風のザラザラ）
  noise(dest, dur, pow, hold = 1) {
    const c = this.ctx, len = Math.max(1, Math.floor(c.sampleRate * dur));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    let v = 0;
    for (let i = 0; i < len; i++) {
      if (i % hold === 0) v = Math.random() * 2 - 1;
      d[i] = v * Math.pow(1 - i / len, pow);
    }
    const src = c.createBufferSource();
    src.buffer = buf;
    return src;
  },
  pass() {
    const o = this.cfg.pass, dest = this.out(o.vol);
    this.tone(dest, o.pitch, 0.06, o.wave, 0.35);
    this.tone(dest, o.pitch * 1.5, 0.06, o.wave, 0.28, 0.045);
  },
  mine() {
    const o = this.cfg.mine, dest = this.out(o.vol);
    this.tone(dest, o.pitch, 0.08, o.wave, 0.3);
    this.tone(dest, o.pitch * 1.5, 0.12, o.wave, 0.3, 0.08);
  },
  beep(hi) { this.tone(this.out(this.cfg.count.vol), hi ? 1046 : 660, 0.16, 'sine', 0.45); },
  hide() { this.tone(this.out(this.cfg.count.vol), 520, 0.3, 'sine', 0.35, 0, 260); },
  boom() {
    const o = this.cfg.boom, dest = this.out(o.vol);
    if (!dest) return;
    const c = this.ctx, t = c.currentTime;
    const len = o.len;
    const bass = o.bass / 100;
    const bright = 300 + (o.tone / 100) ** 2 * 7000; // こもり ⇔ 派手
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    const ng = c.createGain();
    let src;
    switch (o.type) {
      case 'heavy': // 重低音：長くこもった轟音
        src = this.noise(dest, len * 1.2, 1.6);
        lp.frequency.setValueAtTime(bright * 0.5, t);
        lp.frequency.exponentialRampToValueAtTime(70, t + len);
        ng.gain.value = 0.75;
        this.tone(dest, 75, len, 'sine', 1.0 * bass + 0.0002, 0, 18);
        this.tone(dest, 45, len * 1.2, 'sine', 0.7 * bass + 0.0002, 0.03, 20);
        break;
      case 'crack': // 乾いた破裂：短く鋭い
        src = this.noise(dest, len * 0.5, 4);
        lp.frequency.setValueAtTime(Math.min(14000, bright * 1.6), t);
        lp.frequency.exponentialRampToValueAtTime(700, t + len * 0.45);
        ng.gain.value = 1.4;
        this.tone(dest, 1800, 0.03, 'square', 0.25, 0, 300);
        this.tone(dest, 200, Math.min(0.4, len * 0.3), 'sine', 0.5 * bass + 0.0002, 0, 50);
        break;
      case 'retro': // 8bit 風
        src = this.noise(dest, len, 1.8, 28);
        lp.frequency.setValueAtTime(bright, t);
        lp.frequency.exponentialRampToValueAtTime(200, t + len);
        ng.gain.value = 0.7;
        this.tone(dest, 220, len * 0.6, 'square', 0.22 * bass + 0.0002, 0, 35);
        break;
      default: // ドカン（標準）
        src = this.noise(dest, len * 1.05, 2.4);
        lp.frequency.setValueAtTime(bright, t);
        lp.frequency.exponentialRampToValueAtTime(160, t + len * 0.9);
        ng.gain.value = 0.7;
        this.tone(dest, 120, len * 0.7, 'sine', 0.75 * bass + 0.0002, 0, 28);
        break;
    }
    src.connect(lp).connect(ng).connect(dest);
    src.start(t);
  },
  win() {
    const dest = this.out(this.cfg.win.vol);
    [523, 659, 784, 1046].forEach((f, i) => this.tone(dest, f, 0.2, 'triangle', 0.32, i * 0.12));
  },
  // 設定画面のサンプル再生
  sample(sec) {
    switch (sec) {
      case 'master': this.pass(); setTimeout(() => this.boom(), 250); break;
      case 'boom': this.boom(); vibrate([90]); break;
      case 'pass': this.pass(); setTimeout(() => this.pass(), 220); setTimeout(() => this.pass(), 440); break;
      case 'mine': this.mine(); vibrate(35); break;
      case 'count':
        [0, 1, 2].forEach((i) => setTimeout(() => this.beep(false), i * 450));
        setTimeout(() => this.beep(true), 1350);
        setTimeout(() => this.hide(), 2100);
        break;
      case 'win': this.win(); break;
      default: break;
    }
  },
};
['pointerdown', 'keydown', 'touchstart'].forEach((ev) => window.addEventListener(ev, () => Sound.init(), { passive: true }));
function vibrate(p) {
  if (!Sound.cfg.master.vib) return;
  try { navigator.vibrate && navigator.vibrate(p); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- 音の設定画面
const SND_UI = [
  { sec: 'master', title: '全体', rows: [
    ['vol', 'range', '全体の音量', 0, 100, 1, '%'],
    ['muted', 'toggle', 'すべての音を消す'],
    ['vib', 'toggle', 'バイブレーション（スマホ）'],
  ] },
  { sec: 'boom', title: '💥 爆発音', rows: [
    ['vol', 'range', '音量', 0, 100, 1, '%'],
    ['type', 'select', '種類', [['standard', 'ドカン（標準）'], ['heavy', '重低音'], ['crack', '乾いた破裂'], ['retro', 'レトロ（8bit）']]],
    ['len', 'range', '長さ', 0.4, 3, 0.1, '秒'],
    ['bass', 'range', '低音の強さ', 0, 100, 1, '%'],
    ['tone', 'range', '明るさ（こもり ⇔ 派手）', 0, 100, 1, '%'],
  ] },
  { sec: 'pass', title: '💣 爆弾が回る音', rows: [
    ['vol', 'range', '音量', 0, 100, 1, '%'],
    ['wave', 'select', '音色', [['triangle', 'やわらか'], ['sine', 'まるい'], ['square', 'ピコピコ'], ['sawtooth', 'ジャリッ']]],
    ['pitch', 'range', '高さ', 200, 1200, 10, 'Hz'],
  ] },
  { sec: 'mine', title: '⚠ 自分に回ってきた音', rows: [
    ['vol', 'range', '音量', 0, 100, 1, '%'],
    ['wave', 'select', '音色', [['square', 'ピコピコ'], ['triangle', 'やわらか'], ['sine', 'まるい'], ['sawtooth', 'ジャリッ']]],
    ['pitch', 'range', '高さ', 400, 1800, 10, 'Hz'],
  ] },
  { sec: 'count', title: '⏱ カウント音（開始前・表示が消える合図）', rows: [
    ['vol', 'range', '音量', 0, 100, 1, '%'],
  ] },
  { sec: 'win', title: '🏆 勝利の音', rows: [
    ['vol', 'range', '音量', 0, 100, 1, '%'],
  ] },
];

// ---------------------------------------------------------------- 通信
let ws = null, wsOpen = false, retry = 0, noReconnect = false;
let outbox = [];
let offset = 0, bestRtt = Infinity, synced = false;
let S = null, myId = null, roomCode = null;
const srvNow = () => Date.now() + offset;

function send(obj) {
  if (wsOpen) ws.send(JSON.stringify(obj));
  else outbox.push(obj);
}

function connect() {
  if (noReconnect) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  const showTimer = setTimeout(() => { if (!wsOpen) $('#conn').classList.remove('hidden'); }, 800);
  ws.onopen = () => {
    clearTimeout(showTimer);
    wsOpen = true; retry = 0;
    $('#conn').classList.add('hidden');
    bestRtt = Infinity;
    for (let i = 0; i < 3; i++) setTimeout(ping, i * 150);
    if (roomCode) {
      ws.send(JSON.stringify({ t: 'join', code: roomCode, name: myName(), token: TOKEN, spectate: $('#chkSpec').checked, rejoin: true }));
      outbox = outbox.filter((m) => m.t !== 'join' && m.t !== 'create');
    }
    const q = outbox; outbox = [];
    q.forEach((m) => ws.send(JSON.stringify(m)));
  };
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    handle(m);
  };
  ws.onclose = () => {
    clearTimeout(showTimer);
    wsOpen = false;
    if (noReconnect) return;
    $('#conn').textContent = '再接続しています…';
    $('#conn').classList.remove('hidden');
    setTimeout(connect, Math.min(4000, 400 * 2 ** retry++));
  };
}
function ping() { if (wsOpen) ws.send(JSON.stringify({ t: 'ping', c: Date.now() })); }
setInterval(ping, 4000);

function handle(m) {
  switch (m.t) {
    case 'pong': {
      const now = Date.now();
      const rtt = now - m.c;
      bestRtt += 3; // 時計のずれを少しずつ追従
      if (rtt <= bestRtt) { bestRtt = rtt; offset = m.s + rtt / 2 - now; synced = true; }
      break;
    }
    case 'joined':
      roomCode = m.code; myId = m.you;
      store.set('bk_room', roomCode);
      history.replaceState(null, '', '/?room=' + roomCode);
      break;
    case 'state':
      onState(m);
      break;
    case 'error':
      toast(m.msg || 'エラー');
      if (m.code === 'noroom') { clearRoom(); showScreen('title'); }
      break;
    case 'notice':
      toast(m.msg);
      break;
    case 'left':
      clearRoom(); S = null; showScreen('title');
      break;
    case 'kicked':
      noReconnect = true;
      $('#conn').textContent = m.msg + '（再読み込みで戻れます）';
      $('#conn').classList.remove('hidden');
      break;
    default: break;
  }
}

function clearRoom() {
  roomCode = null;
  store.del('bk_room');
  history.replaceState(null, '', '/');
}

let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}

function showScreen(name) {
  for (const s of ['title', 'lobby', 'game']) $('#scr-' + s).classList.toggle('hidden', s !== name);
  if (name === 'game') layout();
}

// ---------------------------------------------------------------- タイトル
const myName = () => $('#inName').value.trim().slice(0, 12);
$('#inName').value = store.get('bk_name', '');
$('#chkSpec').checked = store.get('bk_spec') === '1';
const urlRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase().slice(0, 4);
if (urlRoom) $('#inCode').value = urlRoom;

function needName() {
  const n = myName();
  if (!n) { toast('なまえを入れてください'); $('#inName').focus(); return null; }
  store.set('bk_name', n);
  store.set('bk_spec', $('#chkSpec').checked ? '1' : '0');
  return n;
}
$('#btnCreate').onclick = () => {
  const n = needName(); if (!n) return;
  send({ t: 'create', name: n, token: TOKEN, spectate: $('#chkSpec').checked });
};
function doJoin() {
  const n = needName(); if (!n) return;
  const code = $('#inCode').value.trim().toUpperCase();
  if (code.length !== 4) { toast('4文字の部屋コードを入れてください'); return; }
  send({ t: 'join', code, name: n, token: TOKEN, spectate: $('#chkSpec').checked });
}
$('#btnJoin').onclick = doJoin;
$('#inCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

// ---------------------------------------------------------------- ロビー
$('#btnCopy').onclick = async () => {
  const url = location.origin + '/?room=' + (S ? S.code : '');
  try { await navigator.clipboard.writeText(url); toast('招待リンクをコピーしました'); }
  catch { prompt('このリンクを送ってください', url); }
};
$('#npcMinus').onclick = () => send({ t: 'npc', d: -1 });
$('#npcPlus').onclick = () => send({ t: 'npc', d: 1 });
$('#btnStart').onclick = () => send({ t: 'start' });
$('#btnSpec').onclick = () => {
  const me = S && S.lobby.humans.find((h) => h.id === myId);
  if (me) send({ t: 'spectate', on: !me.spectate });
};
$('#btnLeave').onclick = () => send({ t: 'leave' });

function renderLobby() {
  const L = S.lobby;
  const isHost = S.hostId === myId;
  $('#lbCode').textContent = S.code;
  const players = L.humans.filter((h) => !h.spectate);
  const specs = L.humans.filter((h) => h.spectate);
  const total = players.filter((h) => h.connected).length + L.npcs.length;

  const li = (h) => {
    const tags = [];
    if (h.id === S.hostId) tags.push('<span class="tag">ホスト</span>');
    if (h.id === myId) tags.push('<span class="tag me">あなた</span>');
    if (!h.connected) tags.push('<span class="tag">オフライン</span>');
    return `<li class="${h.connected ? '' : 'off'}"><span class="mini-av" style="--hue:${hueOf(h.id + h.name)}">${esc(initial(h.name))}</span><span class="nm">${esc(h.name)}</span>${tags.join('')}</li>`;
  };
  $('#lbPlayers').innerHTML =
    players.map(li).join('') +
    L.npcs.map((n) => `<li class="npc"><span class="mini-av npc">🤖</span><span class="nm">${esc(n)}</span><span class="tag">NPC</span></li>`).join('');
  $('#lbCount').textContent = `${total} / ${S.limits.max}人`;
  $('#npcNum').textContent = L.npcs.length;
  $('#npcMinus').classList.toggle('hidden', !isHost);
  $('#npcPlus').classList.toggle('hidden', !isHost);
  $('#npcMinus').disabled = L.npcs.length <= L.minNpc;
  $('#npcPlus').disabled = total >= S.limits.max;

  $('#specCard').classList.toggle('hidden', specs.length === 0);
  $('#lbSpecs').innerHTML = specs.map(li).join('');

  const me = L.humans.find((h) => h.id === myId);
  $('#btnSpec').textContent = me && me.spectate ? 'プレイヤーで参加' : '観戦に回る';
  $('#btnStart').classList.toggle('hidden', !isHost);
  $('#waitMsg').classList.toggle('hidden', isHost);
}

// ---------------------------------------------------------------- ゲーム
const tableEl = $('#table'), seatsEl = $('#seats'), bombEl = $('#bomb');
const SEAT_R = 40.5;  // 席の半径（%）
const BOMB_R = 25;    // 爆弾の位置の半径（%）
let seatsKey = '';
let seatAng = {};
let fuseInfo = { round: -1, startAt: 0, fuseMs: 0 };
let lastBoomSeq = null;
let revealDoneKey = '';
let preSecShown = -1;
let passLock = 0;
let winShownKey = '';

function layout() {
  const stage = $('#stage');
  const w = stage.clientWidth - 8, h = stage.clientHeight - 8;
  const size = Math.max(240, Math.min(w, h));
  tableEl.style.width = tableEl.style.height = size + 'px';
  const n = S && S.game ? S.game.players.length : 8;
  const k = n > 14 ? 0.1 : n > 10 ? 0.115 : n > 6 ? 0.135 : 0.155;
  tableEl.style.setProperty('--seat', Math.round(Math.min(74, size * k)) + 'px');
  tableEl.style.setProperty('--bomb', Math.round(Math.min(112, size * (n > 12 ? 0.13 : 0.16))) + 'px');
}
window.addEventListener('resize', layout);

function buildSeats() {
  const g = S.game;
  const n = g.players.length;
  const myIdx = g.players.findIndex((p) => p.id === myId);
  // 自分の席が一番下になるように回転（時計回りはそのまま）
  const base = myIdx >= 0 ? 90 - (myIdx * 360) / n : -90;
  seatsEl.innerHTML = '';
  seatAng = {};
  g.players.forEach((p, i) => {
    const deg = base + (i * 360) / n;
    const a = (deg * Math.PI) / 180;
    seatAng[p.id] = a;
    const el = document.createElement('div');
    el.className = 'seat' + (p.isNpc ? ' npc' : '') + (p.id === myId ? ' me' : '');
    el.dataset.id = p.id;
    el.style.left = 50 + SEAT_R * Math.cos(a) + '%';
    el.style.top = 50 + SEAT_R * Math.sin(a) + '%';
    el.innerHTML =
      `<span class="tag">AUTO</span>` +
      `<div class="av" style="--hue:${hueOf(p.id + p.name)}"><div class="ring"></div>` +
      `<span class="ini">${p.isNpc ? '' : esc(initial(p.name))}</span><span class="npc-badge">🤖</span><span class="x">✕</span></div>` +
      `<div class="nm">${esc(p.name)}</div>`;
    seatsEl.appendChild(el);
  });
  // 時計回りの矢印
  const arrows = $('#arrows');
  arrows.innerHTML = '';
  const cnt = 8;
  for (let i = 0; i < cnt; i++) {
    const deg = base + 180 / n + (i * 360) / cnt;
    const a = (deg * Math.PI) / 180;
    const el = document.createElement('i');
    el.textContent = '›';
    el.style.left = 50 + 30 * Math.cos(a) + '%';
    el.style.top = 50 + 30 * Math.sin(a) + '%';
    el.style.setProperty('--r', deg + 90 + 'deg');
    arrows.appendChild(el);
  }
  layout();
}

function seatEl(id) { return seatsEl.querySelector(`.seat[data-id="${CSS.escape(id)}"]`); }
function playerName(id) {
  const p = S && S.game && S.game.players.find((x) => x.id === id);
  return p ? p.name : '?';
}
function nextAliveId(g, id) {
  const n = g.players.length;
  const i = g.players.findIndex((p) => p.id === id);
  if (i < 0) return null;
  for (let k = 1; k <= n; k++) {
    const p = g.players[(i + k) % n];
    if (p.alive) return p.id;
  }
  return null;
}

function placeBomb(id) {
  const a = seatAng[id];
  if (a === undefined) { bombEl.classList.add('hidden'); return; }
  bombEl.classList.remove('hidden');
  bombEl.style.left = 50 + BOMB_R * Math.cos(a) + '%';
  bombEl.style.top = 50 + BOMB_R * Math.sin(a) + '%';
}

function onState(st) {
  const old = S;
  S = st;
  myId = st.you;
  if (!synced) offset = st.now - Date.now();
  if (st.phase === 'lobby') {
    seatsKey = '';
    $('#overlay').classList.add('hidden');
    renderLobby();
    showScreen('lobby');
    return;
  }
  showScreen('game');
  renderGame(old);
}

function renderGame(old) {
  const g = S.game;
  const key = g.players.map((p) => p.id).join(',') + '|' + myId;
  if (key !== seatsKey) { seatsKey = key; buildSeats(); }

  const alive = g.players.filter((p) => p.alive).length;
  const oldG = old && old.game;
  const oldPhase = old ? old.phase : null;

  // 席の状態
  const nextId = S.phase === 'live' && g.holderId ? nextAliveId(g, g.holderId) : null;
  for (const p of g.players) {
    const el = seatEl(p.id);
    if (!el) continue;
    el.classList.toggle('dead', !p.alive);
    el.classList.toggle('auto', !!p.auto && p.alive);
    el.classList.toggle('holder', p.id === g.holderId);
    el.classList.toggle('next', p.id === nextId && p.id === myId);
  }

  // 上部バー
  $('#gRound').textContent = 'ROUND ' + g.round;
  $('#gAlive').textContent = `生存 ${alive}/${g.players.length}`;
  const blast = alive >= S.limits.blastMin;
  const bl = $('#gBlast');
  bl.textContent = blast ? '爆風あり（ひとつ前も脱落）' : '爆風なし';
  bl.classList.toggle('off', !blast);
  $('#mAbort').classList.toggle('hidden', S.hostId !== myId);

  // 爆発までの時間（最初の5秒だけ届く）
  if (g.fuseMs != null) fuseInfo = { round: g.round, startAt: g.startAt, fuseMs: g.fuseMs };

  // 爆弾の位置
  if (S.phase === 'live') placeBomb(g.holderId);
  else if (S.phase === 'pre') placeBomb(g.startId);
  else bombEl.classList.add('hidden');
  bombEl.classList.toggle('mine', S.phase === 'live' && g.holderId === myId);

  // 効果音
  if (S.phase === 'live') {
    const changed = !oldG || oldPhase !== 'live' || oldG.holderId !== g.holderId;
    if (changed) {
      if (g.holderId === myId) { Sound.mine(); vibrate(35); }
      else if (oldPhase === 'live') Sound.pass();
      passLock = 0;
    }
  }
  if (S.phase === 'live' && oldPhase !== 'live') {
    revealDoneKey = '';
    Sound.beep(true);
    popCenter();
  }

  // 爆発
  const lb = g.lastBoom;
  if (lastBoomSeq === null) {
    lastBoomSeq = lb ? lb.seq : 0; // 途中から開いたときは演出しない
  } else if (lb && lb.seq !== lastBoomSeq) {
    lastBoomSeq = lb.seq;
    if (S.phase === 'boom') playBoom(lb);
  }

  // 決着
  const ov = $('#overlay');
  if (S.phase === 'over') {
    const wk = S.code + ':' + (lb ? lb.seq : '') + ':' + g.winnerId;
    if (winShownKey !== wk) {
      winShownKey = wk;
      showResult();
      setTimeout(() => Sound.win(), 150);
    } else showResult();
  } else {
    ov.classList.add('hidden');
  }
}

function showResult() {
  const g = S.game;
  const isHost = S.hostId === myId;
  $('#ovName').textContent = g.winnerId ? playerName(g.winnerId) : '—';
  const rows = [];
  if (g.winnerId) rows.push({ r: 1, id: g.winnerId, round: null });
  let rank = 2;
  for (let k = g.out.length - 1; k >= 0; k--) {
    for (const id of g.out[k].ids) rows.push({ r: rank, id, round: g.out[k].round });
    rank += g.out[k].ids.length;
  }
  $('#ovRank').innerHTML = rows.map((x) =>
    `<li class="${x.id === myId ? 'me' : ''}"><span class="r">${x.r}位</span><span>${esc(playerName(x.id))}</span>` +
    `<span class="rd">${x.round ? 'R' + x.round + ' 脱落' : '生存'}</span></li>`).join('');
  $('#ovAgain').classList.toggle('hidden', !isHost);
  $('#ovLobby').classList.toggle('hidden', !isHost);
  $('#ovWait').classList.toggle('hidden', isHost);
  $('#overlay').classList.remove('hidden');
}
$('#ovAgain').onclick = () => send({ t: 'start' });
$('#ovLobby').onclick = () => send({ t: 'tolobby' });

function popCenter() {
  const c = $('#center');
  c.classList.remove('pop');
  void c.offsetWidth;
  c.classList.add('pop');
}

function playBoom(lb) {
  const a = seatAng[lb.holderId];
  const fx = $('#fx');
  if (a !== undefined) {
    const x = 50 + SEAT_R * 0.85 * Math.cos(a), y = 50 + SEAT_R * 0.85 * Math.sin(a);
    const core = document.createElement('div');
    core.className = 'boom-core';
    core.style.left = x + '%'; core.style.top = y + '%';
    fx.appendChild(core);
    const size = tableEl.clientWidth;
    const colors = ['#fff3b0', '#ffcb4f', '#ff7a2a', '#ff3d3d', '#ffb347'];
    for (let i = 0; i < 34; i++) {
      const p = document.createElement('div');
      p.className = 'p';
      const ang = Math.random() * Math.PI * 2;
      const dist = size * (0.12 + Math.random() * 0.28);
      p.style.left = x + '%'; p.style.top = y + '%';
      p.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
      p.style.setProperty('--dy', Math.sin(ang) * dist + 'px');
      p.style.setProperty('--c', colors[i % colors.length]);
      p.style.setProperty('--d', (0.5 + Math.random() * 0.6).toFixed(2) + 's');
      const s = 5 + Math.random() * 10;
      p.style.width = p.style.height = s + 'px';
      fx.appendChild(p);
    }
    for (let i = 0; i < 8; i++) {
      const sm = document.createElement('div');
      sm.className = 'smoke';
      const ang = Math.random() * Math.PI * 2;
      const dist = size * (0.05 + Math.random() * 0.12);
      sm.style.left = x + '%'; sm.style.top = y + '%';
      sm.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
      sm.style.setProperty('--dy', Math.sin(ang) * dist + 'px');
      fx.appendChild(sm);
    }
    setTimeout(() => { fx.innerHTML = ''; }, 1800);
  }
  for (const id of lb.victims) {
    const el = seatEl(id);
    if (el) { el.classList.remove('hit'); void el.offsetWidth; el.classList.add('hit'); }
  }
  tableEl.classList.remove('shake'); void tableEl.offsetWidth; tableEl.classList.add('shake');
  const fl = $('#flash');
  fl.classList.remove('on'); void fl.offsetWidth; fl.classList.add('on');
  Sound.boom();
  vibrate(lb.victims.includes(myId) ? [200, 60, 300] : [90]);
  popCenter();
}

// ---------------------------------------------------------------- 毎フレーム描画
const setText = (el, v) => { if (el.textContent !== v) el.textContent = v; };
const cLabel = $('#cLabel'), cMain = $('#cMain'), cSub = $('#cSub'), center = $('#center');
const dockMsg = $('#dockMsg'), holdGauge = $('#holdGauge'), btnPass = $('#btnPass');
const bombGauge = bombEl.querySelector('.bomb-gauge i'), holdGaugeI = holdGauge.querySelector('i');

function gaugeColor(f) { return `hsl(${Math.round(f * 125)}, 85%, 55%)`; }
function setCenterMode(mode) {
  for (const m of ['reveal', 'hidden-time', 'boom', 'win']) center.classList.toggle(m, m === mode);
}

function frame() {
  requestAnimationFrame(frame);
  if (!S || S.phase === 'lobby' || !S.game) return;
  const g = S.game;
  const now = srvNow();
  const L = S.limits;
  const me = g.players.find((p) => p.id === myId);
  const imIn = !!me;
  const imAlive = me && me.alive;
  const holding = S.phase === 'live' && g.holderId === myId;

  // ---- 中央表示
  if (S.phase === 'pre') {
    setCenterMode('');
    const s = Math.max(0, Math.ceil((g.nextAt - now) / 1000));
    setText(cLabel, 'ROUND ' + g.round);
    setText(cMain, s > 0 ? String(s) : 'GO!');
    setText(cSub, g.startId ? `${playerName(g.startId)} から開始` : '');
    if (s !== preSecShown) { preSecShown = s; if (s > 0) Sound.beep(false); }
  } else if (S.phase === 'live') {
    preSecShown = -1;
    const el = now - g.startAt;
    const haveFuse = fuseInfo.round === g.round && fuseInfo.startAt === g.startAt;
    if (haveFuse && el < L.revealMs) {
      setCenterMode('reveal');
      setText(cLabel, '爆発まで');
      setText(cMain, Math.max(0, (fuseInfo.fuseMs - el) / 1000).toFixed(1));
      setText(cSub, `あと ${Math.max(0, Math.ceil((L.revealMs - el) / 1000))} 秒で見えなくなる`);
    } else {
      setCenterMode('hidden-time');
      setText(cLabel, '爆発まで');
      setText(cMain, '??.?');
      setText(cSub, '頭の中で数えろ！');
      const k = g.round + ':' + g.startAt;
      if (revealDoneKey !== k) {
        revealDoneKey = k;
        if (haveFuse) { Sound.hide(); popCenter(); }
      }
    }
  } else if (S.phase === 'boom' && g.lastBoom) {
    setCenterMode('boom');
    const lb = g.lastBoom;
    setText(cLabel, `💥 ${(lb.fuseMs / 1000).toFixed(1)}秒で爆発`);
    setText(cMain, 'BOOM!');
    const names = lb.victims.map(playerName);
    setText(cSub, lb.victims.length > 1 ? `${names[0]} 脱落\n爆風で ${names[1]} も脱落` : `${names[0]} 脱落`);
  } else if (S.phase === 'over') {
    setCenterMode('win');
    setText(cLabel, 'WINNER');
    setText(cMain, g.winnerId ? playerName(g.winnerId) : '—');
    setText(cSub, '');
  }
  cSub.style.whiteSpace = 'pre-line';

  // ---- ゲージ
  let frac = 0;
  if (S.phase === 'live' && g.holderId) {
    frac = clamp(1 - (now - g.holdStart) / L.holdMax, 0, 1);
    const col = gaugeColor(frac);
    const hs = seatEl(g.holderId);
    if (hs) { hs.style.setProperty('--g', frac.toFixed(3)); hs.style.setProperty('--gc', col); }
    bombGauge.style.width = (frac * 100).toFixed(1) + '%';
    bombGauge.style.setProperty('--gc', col);
  }
  holdGauge.classList.toggle('on', holding);
  if (holding) {
    holdGaugeI.style.width = (frac * 100).toFixed(1) + '%';
    holdGaugeI.style.setProperty('--gc', gaugeColor(frac));
  }

  // ---- 下部メッセージとボタン
  btnPass.disabled = !holding;
  let msg = '', cls = '';
  if (!imIn) msg = '観戦中';
  else if (S.phase === 'over') msg = g.winnerId === myId ? '🏆 あなたの勝ち！' : 'ゲーム終了';
  else if (!imAlive) msg = '脱落… 最後まで見届けよう';
  else if (S.phase === 'pre') msg = 'まもなく開始';
  else if (S.phase === 'boom') msg = '';
  else if (holding) { msg = '爆弾を持っている！ 回せ！'; cls = 'mine'; }
  else if (g.holderId && nextAliveId(g, g.holderId) === myId) { msg = '⚠ 次はあなた'; cls = 'warn'; }
  else if (g.holderId) msg = `${playerName(g.holderId)} が持っている`;
  setText(dockMsg, msg);
  dockMsg.className = 'dock-msg ' + cls;
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------- 操作
function doPass() {
  if (!S || S.phase !== 'live' || S.game.holderId !== myId) return;
  const t = Date.now();
  if (t < passLock) return;
  passLock = t + 250;
  send({ t: 'pass' });
}
btnPass.addEventListener('pointerdown', (e) => { e.preventDefault(); doPass(); });
btnPass.addEventListener('click', (e) => e.preventDefault());
bombEl.addEventListener('pointerdown', () => doPass());
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (document.activeElement && /^(INPUT|SELECT)$/.test(document.activeElement.tagName)) return;
  if (!$('#sndPanel').classList.contains('hidden')) return;
  if (e.code === 'Space' || e.key === 'Enter') {
    if (S && S.phase !== 'lobby') { e.preventDefault(); doPass(); }
  }
});

// ---- 音の設定パネル
const updMute = () => { $('#btnMute').textContent = Sound.muted ? '🔇' : '🔊'; };
const fmtVal = (v, step, unit) => (step < 1 ? Number(v).toFixed(1) : String(v)) + (unit || '');

function buildSoundPanel() {
  const body = $('#sndBody');
  body.innerHTML = SND_UI.map((s) => {
    const rows = s.rows.map(([k, type, label, a, b, step, unit]) => {
      const v = Sound.cfg[s.sec][k];
      const attr = `data-sec="${s.sec}" data-k="${k}"`;
      if (type === 'range') {
        return `<label class="srow"><span class="sl">${label}</span>` +
          `<input type="range" ${attr} min="${a}" max="${b}" step="${step}" value="${v}">` +
          `<output>${fmtVal(v, step, unit)}</output></label>`;
      }
      if (type === 'select') {
        return `<label class="srow"><span class="sl">${label}</span><select ${attr}>` +
          a.map(([val, txt]) => `<option value="${val}"${val === v ? ' selected' : ''}>${txt}</option>`).join('') +
          `</select></label>`;
      }
      return `<label class="srow toggle"><span class="sl">${label}</span><input type="checkbox" ${attr}${v ? ' checked' : ''}><i class="sw"></i></label>`;
    }).join('');
    return `<section class="ssec"><div class="ssec-head"><h4>${s.title}</h4>` +
      `<button class="btn small sample" data-sample="${s.sec}">▶ 試聴</button></div>${rows}</section>`;
  }).join('');
}

function onSoundInput(e, play) {
  const el = e.target;
  const { sec, k } = el.dataset;
  if (!sec) return;
  const row = SND_UI.find((s) => s.sec === sec).rows.find((r) => r[0] === k);
  let v;
  if (el.type === 'checkbox') v = el.checked;
  else if (el.type === 'range') v = Number(el.value);
  else v = el.value;
  Sound.cfg[sec][k] = v;
  if (el.type === 'range') el.nextElementSibling.textContent = fmtVal(v, row[5], row[6]);
  Sound.save();
  if (sec === 'master') { Sound.applyMaster(); updMute(); }
  // スライダーを離したとき・種類を変えたときにその音を鳴らして確認
  if (play && !(sec === 'master' && k !== 'vol')) Sound.sample(sec);
}
$('#sndBody').addEventListener('input', (e) => onSoundInput(e, false));
$('#sndBody').addEventListener('change', (e) => onSoundInput(e, true));
$('#sndBody').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sample]');
  if (b) { Sound.init(); Sound.sample(b.dataset.sample); }
});
function openSound() { buildSoundPanel(); $('#sndPanel').classList.remove('hidden'); $('#menu').classList.add('hidden'); }
function closeSound() { $('#sndPanel').classList.add('hidden'); }
$('#sndClose').onclick = closeSound;
$('#sndDone').onclick = closeSound;
$('#sndPanel').addEventListener('pointerdown', (e) => { if (e.target.id === 'sndPanel') closeSound(); });
$('#sndReset').onclick = () => {
  if (!confirm('音の設定を初期値に戻しますか？')) return;
  Sound.cfg = JSON.parse(JSON.stringify(SND_DEFAULT));
  Sound.save(); Sound.applyMaster(); updMute(); buildSoundPanel();
};
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSound(); });
document.querySelectorAll('.open-sound').forEach((b) => { b.onclick = openSound; });
updMute();
$('#btnMute').onclick = openSound;
$('#btnMenu').onclick = (e) => { e.stopPropagation(); $('#menu').classList.toggle('hidden'); };
document.addEventListener('click', () => $('#menu').classList.add('hidden'));
$('#mAbort').onclick = () => { if (confirm('ゲームを中断してロビーに戻りますか？')) send({ t: 'tolobby' }); };
$('#mLeave').onclick = () => { if (confirm('部屋から退出しますか？')) send({ t: 'leave' }); };

// ---------------------------------------------------------------- 起動
const saved = store.get('bk_room');
if (saved && (!urlRoom || urlRoom === saved)) roomCode = saved; // 前回の部屋に自動で戻る
connect();
})();
