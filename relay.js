/**
 * Riposte: Frontline —— 联机中继（relay.js）
 *
 * 纯 Node.js 实现，无第三方依赖。包含两部分：
 *
 *  1) /room/:code  —— 房间中继：房主 WebSocket 与访客 WebSocket 之间转发消息，
 *     兼容客户端 RelayHost / RelayConn 协议（控制帧以 \x02 开头，字段以 \x01 分隔）。
 *
 *  2) /serveur/:id —— 公共大厅（matchmaking）：服务端维护大厅状态、玩家列表、
 *     队伍、投票、倒计时与房主交接，通过 WebSocket 向所有成员广播 etat 状态。
 *
 * HTTP 侧：salonsData() 供 server.js 的 GET /salons 调用；另提供 /sante 探活。
 */
'use strict';

const crypto = require('crypto');
const NET_PROTO = 13;
const CTL = String.fromCharCode(2);
const SEP = String.fromCharCode(1);

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 2 * 1024 * 1024; // 单条消息上限 2MB
const HEARTBEAT_MS = 15000;
const ROOM_TTL = 30 * 60 * 1000;       // 空闲大厅 30 分钟回收
const SRV_MAX_PLAYERS = 12;

// ---------------------------------------------------------------------------
// 极简 RFC6455 WebSocket 实现（仅文本帧 / Ping / Pong / Close，够用即可）
// ---------------------------------------------------------------------------

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = body.length;
  const head = [0x80 | opcode];
  if (len < 126) head.push(len);
  else if (len < 65536) head.push(126, (len >> 8) & 255, len & 255);
  else head.push(127, 0, 0, 0, 0, (len >> 24) & 255, (len >> 16) & 255, (len >> 8) & 255, len & 255);
  return Buffer.concat([Buffer.from(head), body]);
}

function parseFrames(ws, buffer, cb) {
  // 返回剩余字节；cb(text) 回调完整文本消息
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset], b1 = buffer[offset + 1];
    const opcode = b0 & 0x0f;
    const fin = (b0 & 0x80) === 0x80;
    const masked = (b1 & 0x80) === 0x80;
    let len = b1 & 0x7f;
    let p = offset + 2;
    if (len === 126) { if (p + 2 > buffer.length) break; len = buffer.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (p + 8 > buffer.length) break; len = Number(buffer.readBigUInt64BE(p)); p += 8; }
    if (len > MAX_PAYLOAD) { ws.close(1009); return Buffer.alloc(0); }
    if (masked) p += 4;
    if (p + len > buffer.length) break;
    const payload = buffer.slice(p, p + len);
    if (masked) {
      const mask = buffer.slice(p - 4, p);
      for (let i = 0; i < len; i++) payload[i] ^= mask[i % 4];
    }
    if (opcode === 1 && fin) cb(payload.toString('utf8'));
    else if (opcode === 9) sendFrame(ws, 10, payload); // ping -> pong
    else if (opcode === 8) ws._closed = true;
    offset = p + len;
  }
  return buffer.slice(offset);
}

function sendFrame(ws, opcode, payload) {
  if (!ws || ws._closed || ws._res.destroyed) return;
  try { ws._res.write(encodeFrame(opcode, payload)); } catch (e) { /* 连接已断 */ }
}

function attachSocket(req, res, onMessage, onClose, head) {
  const key = req.headers['sec-websocket-key'] || '';
  res.writeHead(101, {
    'Upgrade': 'websocket',
    'Connection': 'Upgrade',
    'Sec-WebSocket-Accept': wsAccept(key)
  });
  const sock = res.socket || res._socket;
  const ws = {
    _res: res, _sock: sock, _closed: false,
    id: '', room: null,
    send(text) { sendFrame(this, 1, text); },
    close(code) {
      if (this._closed) return;
      this._closed = true;
      try { res.end(encodeFrame(8, String(code || 1000))); } catch (e) {}
      try { sock.destroy(); } catch (e) {}
    },
    onMessage, onClose
  };
  let buf = Buffer.isBuffer(head) && head.length ? Buffer.from(head) : Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    buf = parseFrames(ws, buf, (text) => { if (!ws._closed) onMessage && onMessage(ws, text); });
  });
  sock.on('close', () => { if (!ws._closed) { ws._closed = true; onClose && onClose(ws); } });
  sock.on('error', () => { if (!ws._closed) { ws._closed = true; onClose && onClose(ws); } });
  // 心跳：定期 ping，避免空闲连接被中间网关切断
  ws._hb = setInterval(() => { if (!ws._closed) sendFrame(ws, 9, 'h'); }, HEARTBEAT_MS);
  ws._hb.unref && ws._hb.unref();
  return ws;
}

// ---------------------------------------------------------------------------
// 房间中继（/room/:code）
// ---------------------------------------------------------------------------

const relayRooms = new Map(); // code -> { host, guests: Map(id->ws), meta, banned:Set, createdAt }

function relayRefuse(ws, code, reason) {
  ws.send(CTL + 'refuse' + SEP + code + (reason ? SEP + reason : ''));
  ws.close(code);
}

function relayHostCleanup(room) {
  for (const g of room.guests.values()) { g.send(CTL + 'host' + SEP + '0'); g.close(4004); }
  relayRooms.delete(room.code);
}

function relayAttachHost(req, res, code, q, head) {
  const id = q.get('id') || crypto.randomBytes(8).toString('hex');
  let room = relayRooms.get(code);
  if (room && room.host) { relayRefuse(room.host, 4011, 'taken'); relayHostCleanup(room); room = null; }
  if (!room) {
    room = { code, host: null, guests: new Map(), meta: null, banned: new Set(), createdAt: Date.now() };
    relayRooms.set(code, room);
  }
  let ws;
  ws = attachSocket(req, res, (w, text) => relayHostMsg(room, w, text), () => relayHostDrop(room, ws), head);
  ws.id = id; ws.room = room;
  room.host = ws;
  // 同步当前已连接访客列表
  const ids = [...room.guests.keys()].join(',');
  ws.send(CTL + 'sync' + SEP + ids);
  if (room.meta) ws.send(CTL + 'pub' + SEP + room.meta);
  return ws;
}

function relayHostMsg(room, ws, text) {
  // 控制帧：pub / kick / ban；数据帧：<guestId>\x01<json>（可逗号群发）
  if (text.charCodeAt(0) === 2) {
    const [cmd, a, b] = text.slice(1).split(SEP);
    if (cmd === 'pub') room.meta = a || '';
    else if (cmd === 'kick' && a) { const g = room.guests.get(a); if (g) { relayRefuse(g, 4003); room.guests.delete(a); } }
    else if (cmd === 'ban' && a) room.banned.add(a);
    return;
  }
  const cut = text.indexOf(SEP);
  if (cut < 1) return;
  const ids = text.slice(0, cut).split(',');
  const payload = text.slice(cut + 1);
  for (const gid of ids) {
    const g = room.guests.get(gid);
    if (g && !g._closed) g.send(payload);
  }
}

function relayHostDrop(room, ws) {
  if (!room || room.host !== ws) return;
  room.host = null;
  // 通知访客房主下线，进入宽限等待
  for (const g of room.guests.values()) g.send(CTL + 'host' + SEP + '0');
  setTimeout(() => {
    if (room.host) return; // 已由新房主接管
    for (const g of room.guests.values()) { if (!g._closed) g.close(4004); }
    relayRooms.delete(room.code);
  }, 15000).unref?.();
}

function relayAttachGuest(req, res, code, q, head) {
  const id = q.get('id') || 'g' + crypto.randomBytes(6).toString('hex');
  const room = relayRooms.get(code);
  if (!room || !room.host) {
    const ws = attachSocket(req, res, () => {}, () => {}, head);
    relayRefuse(ws, 4004);
    return ws;
  }
  if (room.banned.has(id)) {
    const ws = attachSocket(req, res, () => {}, () => {}, head);
    relayRefuse(ws, 4003);
    return ws;
  }
  if (room.guests.size >= SRV_MAX_PLAYERS) {
    const ws = attachSocket(req, res, () => {}, () => {}, head);
    relayRefuse(ws, 4002);
    return ws;
  }
  if (room.guests.has(id)) {
    const ws = attachSocket(req, res, () => {}, () => {}, head);
    relayRefuse(ws, 4011);
    return ws;
  }
  const ws = attachSocket(req, res, (w, text) => {
    // 访客 → 房主：原样 JSON，前缀访客 id
    if (room.host && !room.host._closed) room.host.send(id + SEP + text);
  }, () => {
    room.guests.delete(id);
    if (room.host && !room.host._closed) room.host.send(CTL + 'leave' + SEP + id);
  }, head);
  ws.id = id; ws.room = room;
  room.guests.set(id, ws);
  ws.send(CTL + 'host' + SEP + '1');
  if (room.host && !room.host._closed) room.host.send(CTL + 'join' + SEP + id);
  return ws;
}

// ---------------------------------------------------------------------------
// 公共大厅（/serveur/:id）
// ---------------------------------------------------------------------------

const srvRooms = new Map();   // id -> lobby
const srvBySocket = new Map(); // ws -> lobby

function srvCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += abc[crypto.randomInt(abc.length)];
  return s;
}
function srvRoomId() {
  const abc = 'abcdefghjkmnpqrstuvwxyz';
  let id;
  do { id = abc[crypto.randomInt(abc.length)] + abc[crypto.randomInt(abc.length)] + abc[crypto.randomInt(abc.length)] + (1 + crypto.randomInt(9)); } while (srvRooms.has(id));
  return id;
}

function defaultCfg(make) {
  return {
    b: make && make.b ? 1 : 1,
    df: clampInt(make && make.df, 0, 3, 2),
    lim: clampInt(make && make.lim, 1, 999, 30),
    min: clampInt(make && make.min, 1, 99, 10),
    pub: make && make.pub ? 1 : 0,
    ba: make && make.ba != null ? clampInt(make.ba, 0, 6, 6) : 6,
    bb: make && make.bb != null ? clampInt(make.bb, 0, 6, 6) : 6,
    map: make && make.m || 'sable',
    mode: make && make.o || 'tdm'
  };
}
function clampInt(v, lo, hi, dft) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return dft;
  return Math.max(lo, Math.min(hi, n));
}

function createSrvRoom(make) {
  const id = srvRoomId();
  const cfg = defaultCfg(make);
  const room = {
    id, cfg, owner: '',
    players: new Map(),
    phase: 'attente',
    code: '',           // 对局中继码（lancement/partie 阶段）
    hote: '',           // 当前对局房主 client id
    countdown: 0,
    vo: false, c: [], vt: [0, 0], mv: -1,
    createdAt: Date.now(),
    wait: null
  };
  srvRooms.set(id, room);
  return room;
}

function srvEtat(room, viewerId) {
  const j = [...room.players.values()].map((p) => [p.id, p.n, p.lv, p.t, p.u || '', p.pg || 0]);
  const cfg = room.cfg;
  return {
    t: 'etat',
    i: room.id,
    ph: room.phase,
    o: cfg.mode,
    k: room.players.size,
    m: cfg.map,
    c: room.c,
    vt: room.vt,
    mv: room.mv,
    vo: room.vo,
    r: Math.max(0, room.countdown - Date.now()),
    s: 1,
    x: SRV_MAX_PLAYERS,
    me: viewerId,
    j,
    code: room.phase === 'partie' || room.phase === 'lancement' ? room.code : '',
    hote: room.hote,
    own: room.owner,
    ps: room.owner === viewerId,
    cfg: { b: cfg.b, df: cfg.df, lim: cfg.lim, min: cfg.min, pub: cfg.pub, ba: cfg.ba, bb: cfg.bb }
  };
}

function srvBroadcast(room, excludeId) {
  for (const p of room.players.values()) {
    if (p.id === excludeId) continue;
    if (!p.ws._closed) p.ws.send(JSON.stringify(srvEtat(room, p.id)));
  }
}

function srvRefuse(ws, code) {
  ws.send(CTL + 'refuse' + SEP + code);
  ws.close(code);
}

function srvAttach(req, res, roomId, q, head) {
  const proto = parseInt(q.get('v'), 10);
  const id = q.get('id') || 's' + crypto.randomBytes(8).toString('hex');
  const name = String(q.get('n') || 'Soldat').slice(0, 16);
  const u = String(q.get('u') || '').slice(0, 32);
  const lv = clampInt(q.get('lv'), 0, 999, 1);
  const h = clampInt(q.get('h'), 0, 2, 1);

  if (proto && proto !== NET_PROTO) {
    const ws = attachSocket(req, res, () => {}, () => {}, head);
    srvRefuse(ws, 4005); return ws;
  }

  let room;
  if (roomId === 'nouveau') {
    room = createSrvRoom(Object.fromEntries(q));
  } else {
    room = srvRooms.get(roomId);
    if (!room) { const ws = attachSocket(req, res, () => {}, () => {}, head); srvRefuse(ws, 4004); return ws; }
  }
  if (room.players.size >= SRV_MAX_PLAYERS) {
    const ws = attachSocket(req, res, () => {}, () => {}, head);
    srvRefuse(ws, 4002); return ws;
  }
  if (room.players.has(id)) {
    const ws = attachSocket(req, res, () => {}, () => {}, head);
    srvRefuse(ws, 4011); return ws;
  }

  const ws = attachSocket(req, res, (w, text) => srvMsg(room, w, text), () => srvDrop(room, ws), head);
  ws.id = id;
  const team = room.cfg.ba >= 0 ? (room.players.size % 2) : 0;
  room.players.set(id, { id, n: name, u, lv, t: team, h, ws, pg: 0, jeu: 0 });
  if (!room.owner) room.owner = id;
  srvBySocket.set(ws, room);
  ws.send(JSON.stringify(srvEtat(room, id)));
  srvBroadcast(room, id);
  return ws;
}

function srvDrop(room, ws) {
  if (!room) return;
  srvBySocket.delete(ws);
  room.players.delete(ws.id);
  if (room.owner === ws.id) {
    const rest = [...room.players.keys()];
    room.owner = rest[0] || '';
  }
  if (room.players.size === 0) {
    srvRooms.delete(room.id);
    return;
  }
  srvBroadcast(room);
}

function srvMsg(room, ws, raw) {
  let m;
  try { m = JSON.parse(raw); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;
  const me = room.players.get(ws.id);
  if (!me) return;
  const isOwner = room.owner === ws.id;

  switch (m.t) {
    case 'cfg': {
      if (!isOwner) return;
      const c = room.cfg;
      if (m.m) c.map = String(m.m);
      if (m.o) c.mode = String(m.o);
      c.b = m.b != null ? (m.b ? 1 : 0) : c.b;
      c.df = clampInt(m.df, 0, 3, c.df);
      c.lim = clampInt(m.lim, 1, 999, c.lim);
      c.min = clampInt(m.min, 1, 99, c.min);
      c.pub = m.pub ? 1 : 0;
      if (c.ba >= 0) { c.ba = clampInt(m.ba, 0, 6, c.ba); c.bb = clampInt(m.bb, 0, 6, c.bb); }
      srvBroadcast(room);
      break;
    }
    case 'lancer': {
      if (!isOwner || room.phase !== 'attente') return;
      room.phase = 'decompte';
      room.countdown = Date.now() + 5000;
      srvBroadcast(room);
      setTimeout(() => srvLaunch(room), 5000).unref?.();
      break;
    }
    case 'vote': {
      const c = clampInt(m.c, 0, 1, 0);
      if (room.vo) { room.vt[c]++; room.mv = c; }
      srvBroadcast(room);
      break;
    }
    case 'equipe': {
      if (room.cfg.ba < 0) return;
      const target = m.id ? room.players.get(m.id) : me;
      if (!target) return;
      if (target.id !== me.id && !isOwner) return;
      target.t = 1 - target.t;
      srvBroadcast(room);
      break;
    }
    case 'exclure': {
      if (!isOwner) return;
      const t = room.players.get(m.id);
      if (t && t.id !== me.id) { srvRefuse(t.ws, 4003); room.players.delete(t.id); srvBroadcast(room); }
      break;
    }
    case 'chat': {
      const x = String(m.x || '').slice(0, 200);
      if (!x) return;
      for (const p of room.players.values()) {
        if (!p.ws._closed) p.ws.send(JSON.stringify({ t: 'chat', id: me.id, n: me.n, x }));
      }
      break;
    }
    case 'lv': { me.lv = clampInt(m.lv, 0, 999, me.lv); srvBroadcast(room); break; }
    case 'h': { me.h = clampInt(m.h, 0, 2, me.h); me.jeu = m.jeu ? 1 : 0; break; }
    case 'ouvert':
    case 'fin':
    case 'echec': {
      // 对局交接结果回执：由被选为房主的客户端回报
      if (room.wait && String(m.code) === room.code) room.wait = null;
      if (m.t === 'fin') { srvRooms.delete(room.id); }
      break;
    }
  }
}

function srvLaunch(room) {
  if (!srvRooms.has(room.id) || room.phase !== 'decompte') return;
  room.code = srvCode();
  room.phase = 'lancement';
  // 选房主：优先 owner，其次在线且在大厅的玩家
  const order = [room.owner, ...[...room.players.keys()]];
  const hostId = order.find((id) => room.players.has(id)) || '';
  room.hote = hostId;
  room.wait = { n: room.players.size, at: Date.now() };
  srvBroadcast(room);
  const host = room.players.get(hostId);
  if (host) {
    host.ws.send(JSON.stringify({
      t: 'hote', migr: false, code: room.code, key: crypto.randomBytes(24).toString('hex'),
      m: room.cfg.map, o: room.cfg.mode, b: room.cfg.b, df: room.cfg.df,
      lim: room.cfg.lim, min: room.cfg.min, n: room.players.size,
      ba: room.cfg.ba, bb: room.cfg.bb
    }));
  }
  // 超时未完成交接则回收大厅
  setTimeout(() => {
    if (srvRooms.has(room.id) && room.wait) srvRooms.delete(room.id);
  }, 45000).unref?.();
}

// ---------------------------------------------------------------------------
// HTTP / 汇总数据
// ---------------------------------------------------------------------------

function salonsData() {
  const salons = [];
  for (const room of relayRooms.values()) {
    if (!room.meta) continue;
    let meta = {};
    try { meta = JSON.parse(room.meta); } catch (e) {}
    salons.push({
      c: room.code, n: meta.n || 'Soldat', m: meta.m || 'sable', o: meta.o || 'tdm',
      j: room.guests.size + 1, x: meta.x || SRV_MAX_PLAYERS, p: meta.p || 'lobby',
      v: NET_PROTO, pg: 0
    });
  }
  const serveurs = [];
  const crees = [];
  for (const room of srvRooms.values()) {
    const entry = {
      i: room.id, o: room.cfg.mode, k: SRV_MAX_PLAYERS, m: room.cfg.map,
      j: room.players.size, x: SRV_MAX_PLAYERS, p: room.phase, pg: 0, v: NET_PROTO
    };
    serveurs.push(entry);
    if (room.cfg.pub) crees.push({ ...entry, pv: 0, n: (room.players.get(room.owner) || {}).n || 'Soldat' });
  }
  const joueurs = [...srvRooms.values()].reduce((n, r) => n + r.players.size, 0) + relayRooms.size;
  return { serveurs, salons, crees, joueurs };
}

// 陈旧大厅回收
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of srvRooms) {
    if (room.players.size === 0 || now - room.createdAt > ROOM_TTL) srvRooms.delete(id);
  }
  for (const [code, room] of relayRooms) {
    if (!room.host && room.guests.size === 0) relayRooms.delete(code);
    else if (now - room.createdAt > ROOM_TTL) relayRooms.delete(code);
  }
}, 60000).unref?.();

// ---------------------------------------------------------------------------
// 挂载到 http server
// ---------------------------------------------------------------------------

function attach(server) {
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const q = url.searchParams;
    let m;
    socket.on('error', () => { try { socket.destroy(); } catch (e) {} });

    if ((m = url.pathname.match(/^\/room\/([A-Za-z0-9]{5})$/))) {
      const role = q.get('role');
      if (role === 'host') relayAttachHost(req, socketRes(req, socket), m[1], q, head);
      else relayAttachGuest(req, socketRes(req, socket), m[1], q, head);
      return;
    }
    if ((m = url.pathname.match(/^\/serveur\/(.+)$/))) {
      srvAttach(req, socketRes(req, socket), decodeURIComponent(m[1]), q, head);
      return;
    }
    socket.destroy();
  });
}

// upgrade 阶段需要一个伪 res 对象：复用原始 socket 写 101 响应头
function socketRes(req, socket) {
  return {
    _socket: socket,
    destroyed: false,
    writeHead(status, headers) {
      const lines = [`HTTP/1.1 ${status} Switching Protocols`, 'Upgrade: websocket', 'Connection: Upgrade'];
      for (const k in headers) lines.push(`${k}: ${headers[k]}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
    },
    write(chunk) { socket.write(chunk); return true; },
    end(chunk) { if (chunk) socket.write(chunk); socket.end(); },
    destroy() { this.destroyed = true; socket.destroy(); }
  };
}

module.exports = { attach, salonsData, NET_PROTO };
