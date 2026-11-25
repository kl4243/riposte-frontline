/**
 * Riposte: Frontline —— 内置服务器 (server.js)
 * 提供静态页面与全部 /api 接口，数据以 JSON 文件持久化保存（永久保存）。
 * 纯 Node.js 实现，无第三方依赖。
 *
 * 启动: node server.js   然后浏览器访问 http://localhost:3000
 * 开发者账号: 123456 / 123456
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const relay = require('./relay');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
const INDEX_FILE = path.join(ROOT, 'index.html');

const COOKIE_NAME = 'cod_sid';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 5; // 5 年，近似"永久"保存登录
const COMMENT_MAX = 500;

// ---------------------------------------------------------------------------
// 称号系统
//   - 普通称号：所有账号按等级解锁，可自由切换
//   - 专属称号："开发者团队"仅开发者账号（123456）可用
// ---------------------------------------------------------------------------
const DEV_TITLE = '开发者团队';
const DEV_XP = 15723488; // 达到客户端等级上限 999 级所需 XP
const TITLES = [
  { name: '新兵',     level: 1 },
  { name: '列兵',     level: 5 },
  { name: '下士',     level: 10 },
  { name: '中士',     level: 20 },
  { name: '上士',     level: 35 },
  { name: '军士长',   level: 50 },
  { name: '少尉',     level: 75 },
  { name: '中尉',     level: 100 },
  { name: '上尉',     level: 150 },
  { name: '少校',     level: 200 },
  { name: '中校',     level: 300 },
  { name: '上校',     level: 450 },
  { name: '准将',     level: 600 },
  { name: '少将',     level: 750 },
  { name: '将军',     level: 900 }
];
function isDev(u) { return !!(u && (u.username === '123456' || u.moderator)); }
function unlockedTitles(u) {
  const lv = levelOfXp(u.xp || 0);
  let list = TITLES.filter((t) => lv >= t.level).map((t) => t.name);
  if (!list.length) list = [TITLES[0].name]; // 保证每个账号至少有一个基础称号
  if (isDev(u) && list.indexOf(DEV_TITLE) < 0) list.push(DEV_TITLE);
  return list;
}
function validTitle(u, name) {
  if (typeof name !== 'string') return false;
  const t = name.trim().slice(0, 16);
  if (t === DEV_TITLE) return isDev(u);
  return unlockedTitles(u).indexOf(t) >= 0;
}

// ---------------------------------------------------------------------------
// 持久化存储
// ---------------------------------------------------------------------------
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(AVATAR_DIR, { recursive: true });

function blankStats() {
  return { kills: 0, deaths: 0, wins: 0, matches: 0, assists: 0, hits: 0, shots: 0, headshots: 0, bestStreak: 0, seconds: 0 };
}

function freshDB() {
  return { version: 1, users: {}, sessions: {}, matches: {}, posts: [], reports: [], seq: 1 };
}

let db;
function loadDB() {
  const candidates = [DB_FILE, DB_FILE + '.bak'];
  for (const f of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.users && typeof parsed.users === 'object') {
        return Object.assign(freshDB(), parsed);
      }
    } catch (e) { /* 尝试下一个候选 */ }
  }
  return freshDB();
}
db = loadDB();
// ---- 数据自愈：规范化/补全用户记录，保证老账号与损坏数据可恢复 ----
function healDB() {
  let changed = false;
  db.users = db.users || {};
  db.sessions = db.sessions || {};
  db.matches = db.matches || {};
  db.posts = Array.isArray(db.posts) ? db.posts : [];
  db.reports = Array.isArray(db.reports) ? db.reports : [];
  db.seq = Number(db.seq) || 1;
  const arrFields = ['recent', 'friends', 'sent', 'received', 'invites', 'notifications'];
  for (const [key, u] of Object.entries(db.users)) {
    if (!u || typeof u !== 'object') { delete db.users[key]; changed = true; continue; }
    if (!u.username) { u.username = key; changed = true; }
    if (!u.id) { u.id = String(db.seq++); changed = true; }
    if (typeof u.xp !== 'number' || !isFinite(u.xp)) { u.xp = 0; changed = true; }
    // 游戏数据：统计字段补全（永久保存的关键字段）
    const st = Object.assign(blankStats(), u.stats && typeof u.stats === 'object' ? u.stats : {});
    for (const k in st) if (typeof st[k] !== 'number' || !isFinite(st[k]) || st[k] < 0) { st[k] = 0; changed = true; }
    u.stats = st;
    if (!u.displayName) { u.displayName = u.username; changed = true; }
    if (u.banned === undefined) { u.banned = false; changed = true; }
    for (const f of arrFields) if (!Array.isArray(u[f])) { u[f] = []; changed = true; }
    if (u.avatar === undefined) { u.avatar = 0; changed = true; }
    if (!u.createdAt) { u.createdAt = new Date().toISOString(); changed = true; }
  }
  if (changed) { try { writeDB(); } catch (_) {} }
}
// 限制无界增长：会话与对局记录保留上限，避免长期运行内存膨胀
(function pruneDB() {
  const MAX_SESSIONS = 20000, MAX_MATCHES = 20000;
  const sk = Object.keys(db.sessions || {});
  if (sk.length > MAX_SESSIONS) for (const k of sk.slice(0, sk.length - MAX_SESSIONS)) delete db.sessions[k];
  const mk = Object.keys(db.matches || {});
  if (mk.length > MAX_MATCHES) for (const k of mk.slice(0, mk.length - MAX_MATCHES)) delete db.matches[k];
})();

let saveTimer = null;
let saveFailures = 0;
healDB();  // 启动自愈：补全老账号缺失的游戏数据字段
function writeDB() {
  const data = JSON.stringify(db, null, 2);
  const tmp = DB_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, data);
    // 写入前保留上一份成功快照，便于损坏时恢复
    if (fs.existsSync(DB_FILE) && saveFailures === 0) {
      try { fs.copyFileSync(DB_FILE, DB_FILE + '.bak'); } catch (_) {}
    }
    fs.renameSync(tmp, DB_FILE);
    saveFailures = 0;
    return true;
  } catch (e) {
    saveFailures++;
    console.error('[存档失败]', e.message);
    // 主路径失败时尝试直接写目标文件，尽量不丢数据
    try { fs.writeFileSync(DB_FILE, data); return true; } catch (_) {}
    return false;
  }
}
function save() {
  // 合并写盘，降低频繁请求时的 IO
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeDB(); }, 40);
}
function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  writeDB();
}

// ---------------------------------------------------------------------------
// 等级曲线（与客户端 levelOfXp / pxpForLevel 保持一致）
// ---------------------------------------------------------------------------
const PLAYER_LEVEL_MAX = 999;
function pxpForLevel(l) { return 250 * Math.pow(Math.max(0, l - 1), 1.6); }
function levelOfXp(xp) {
  let l = Math.min(PLAYER_LEVEL_MAX, Math.max(1, Math.floor(Math.pow(Math.max(0, xp) / 250, 1 / 1.6)) + 1));
  while (l > 1 && xp < pxpForLevel(l)) l--;
  while (l < PLAYER_LEVEL_MAX && xp >= pxpForLevel(l + 1)) l++;
  return l;
}
function levelObject(xp) {
  xp = Math.max(0, Math.floor(xp || 0));
  const level = levelOfXp(xp);
  const into = Math.max(0, xp - pxpForLevel(level));
  const need = level >= PLAYER_LEVEL_MAX ? 0 : Math.max(0, pxpForLevel(level + 1) - pxpForLevel(level));
  return { level, xp, into, need, up: level >= PLAYER_LEVEL_MAX };
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
function hashPassword(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 64).toString('hex');
}
function makePassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, passHash: hashPassword(pw, salt) };
}
function checkPassword(user, pw) {
  try {
    const h = hashPassword(pw, user.salt);
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(user.passHash, 'hex'));
  } catch (e) { return false; }
}
function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 10; i++) s += chars[crypto.randomInt(chars.length)];
  return s;
}
function newId() { return String(db.seq++); }
function cleanName(s) { return String(s == null ? '' : s).trim().slice(0, 16); }
function validUsername(u) { return /^[A-Za-z0-9_\u4e00-\u9fa5]{2,16}$/.test(u); }
function normKey(u) { return String(u || '').toLowerCase(); }
function findUserByLogin(login) {
  const k = Object.keys(db.users).find((name) => normKey(name) === normKey(login));
  return k ? db.users[k] : null;
}

// ---------------------------------------------------------------------------
// 开发者账号（账号 123456 / 密码 123456）
// ---------------------------------------------------------------------------
function ensureDevAccount() {
  let dev = db.users['123456'];
  if (!dev) {
    const p = makePassword('123456');
    dev = {
      id: newId(), username: '123456', displayName: '开发者',
      salt: p.salt, passHash: p.passHash, recoveryCode: randomCode(),
      avatar: 0, moderator: true, banned: false, title: DEV_TITLE,
      createdAt: new Date().toISOString(), xp: DEV_XP,
      stats: blankStats(), recent: [], arsenal: null,
      friends: [], sent: [], received: [], invites: [], notifications: [],
      createdBySystem: true
    };
    db.users['123456'] = dev;
    save();
  } else {
    // 兼容旧数据：开发者账号始终升到最高等级并授予专属称号
    let changed = false;
    if ((dev.xp || 0) < DEV_XP) { dev.xp = DEV_XP; changed = true; }
    if (dev.title !== DEV_TITLE) { dev.title = DEV_TITLE; changed = true; }
    if (!dev.moderator) { dev.moderator = true; changed = true; }
    if (changed) save();
  }
  return dev;
}
ensureDevAccount();

// ---------------------------------------------------------------------------
// 会话（cookie）
// ---------------------------------------------------------------------------
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
// 判断是否经 HTTPS 反向代理访问（ Cloudflare tunnel / WorkBuddy 网关等），
// 用于给会话 cookie 加 Secure + SameSite=None，避免跨站 iframe 内 cookie 被浏览器拦截。
function isProxyHttps(req) {
  const p = String((req.headers && (req.headers['x-forwarded-proto'] || req.headers['x-forwarded-protocol'])) || '').split(',')[0].trim().toLowerCase();
  return p === 'https';
}
// 会话 id 允许来自 cookie，或客户端显式携带的 x-session-token 头（localStorage 兜底，
// 兼容第三方 cookie 被禁用 / 跨站 iframe 场景）。
function sessionIdFrom(req) {
  const hdr = String((req.headers && req.headers['x-session-token']) || '').trim();
  return hdr || parseCookies(req)[COOKIE_NAME] || '';
}
function currentUser(req) {
  const sid = sessionIdFrom(req);
  const name = sid && db.sessions[sid];
  if (!name) return null;
  const u = db.users[name];
  return u && !u.banned ? u : null;
}
function issueSession(res, user, req) {
  const sid = crypto.randomBytes(24).toString('hex');
  db.sessions[sid] = user.username;
  save();
  // 始终把 sid 通过响应头返回，前端存入 localStorage 作为 cookie 之外的兜底通道。
  res.setHeader('X-Session-Token', sid);
  // 经 HTTPS 反代时用 SameSite=None; Secure，支持跨站 iframe；本地 HTTP 保持 Lax。
  const proxyHttps = isProxyHttps(req);
  const cookie = proxyHttps
    ? `${COOKIE_NAME}=${sid}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=None`
    : `${COOKIE_NAME}=${sid}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax`;
  res.setHeader('Set-Cookie', cookie);
  return sid;
}
function clearSession(req, res) {
  const sid = sessionIdFrom(req);
  if (sid) delete db.sessions[sid];
  save();
  const proxyHttps = isProxyHttps(req);
  const cookie = proxyHttps
    ? `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None`
    : `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
  res.setHeader('Set-Cookie', cookie);
}

// ---------------------------------------------------------------------------
// 数据视图（返回给客户端的结构）
// ---------------------------------------------------------------------------
function publicUser(u, viewer) {
  const o = {
    id: u.id, username: u.username, displayName: u.displayName || u.username,
    avatar: u.avatar || 0, title: u.title || '',
    moderator: !!u.moderator, hasPassword: true, hasRecovery: !!u.recoveryCode,
    createdAt: u.createdAt, modOpen: u.moderator ? openReportCount() : 0
  };
  // 仅本人可见可用称号列表（供客户端渲染称号切换 UI）
  if (viewer && normKey(viewer.username) === normKey(u.username)) {
    o.titles = unlockedTitles(u);
    o.self = true;
  }
  return o;
}
function accountPayload(u, viewer) {
  return {
    user: publicUser(u, viewer),
    level: levelObject(u.xp),
    stats: Object.assign(blankStats(), u.stats || {}),
    recent: Array.isArray(u.recent) ? u.recent : []
  };
}
function openReportCount() { return db.reports.filter((r) => !r.resolved).length; }

// ---------------------------------------------------------------------------
// 通知
// ---------------------------------------------------------------------------
function notify(toUser, kind, fromUser, data) {
  if (!toUser) return;
  if (!Array.isArray(toUser.notifications)) toUser.notifications = [];
  toUser.notifications.unshift({
    id: newId(), kind,
    from: fromUser ? { username: fromUser.username, displayName: fromUser.displayName, avatar: fromUser.avatar || 0 } : null,
    data: data || {}, read: false, createdAt: new Date().toISOString()
  });
  if (toUser.notifications.length > 100) toUser.notifications.length = 100;
  save();
}
function unreadCount(u) {
  return (u.notifications || []).filter((n) => !n.read).length;
}

// ---------------------------------------------------------------------------
// 好友关系
// ---------------------------------------------------------------------------
function relation(viewer, target) {
  if (!viewer || !target) return 'none';
  if (normKey(viewer.username) === normKey(target.username)) return 'me';
  const t = normKey(target.username);
  if ((viewer.friends || []).some((x) => normKey(x) === t)) return 'friend';
  if ((viewer.sent || []).some((x) => normKey(x) === t)) return 'sent';
  if ((viewer.received || []).some((x) => normKey(x) === t)) return 'received';
  return 'none';
}
function shortUser(u, viewer) {
  return {
    username: u.username, displayName: u.displayName || u.username,
    avatar: u.avatar || 0, level: levelObject(u.xp).level,
    online: !!u.online, state: u.state || 'menu',
    relation: relation(viewer, u)
  };
}
function removeFrom(arr, name) {
  const t = normKey(name);
  return arr.filter((x) => normKey(x) !== t);
}
function addUnique(arr, name) {
  if (!arr.some((x) => normKey(x) === normKey(name))) arr.push(name);
  return arr;
}

// ---------------------------------------------------------------------------
// 社区
// ---------------------------------------------------------------------------
function postView(p, viewer) {
  const author = db.users[p.username] || { displayName: p.username, avatar: 0 };
  return {
    id: p.id, kind: p.kind, body: p.body, rating: p.rating || 0,
    username: p.username, displayName: author.displayName || p.username,
    avatar: author.avatar || 0, created_at: p.createdAt,
    votes: (p.votes || []).length,
    mine: !!viewer && normKey(viewer.username) === normKey(p.username),
    voted: !!viewer && (p.votes || []).some((x) => normKey(x) === normKey(viewer.username)),
    flagged: !!viewer && (p.flaggedBy || []).some((x) => normKey(x) === normKey(viewer.username)),
    hidden: !!p.hidden, status: p.status || '', reply: p.reply || '',
    reports: (p.flaggedBy || []).length
  };
}

// ---------------------------------------------------------------------------
// HTTP 响应助手
// ---------------------------------------------------------------------------
// 统一安全响应头（不阻断 iframe 嵌入与 WebSocket 升级）
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'X-XSS-Protection': '0'
};
function sendJSON(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj == null ? {} : obj);
  res.writeHead(status, Object.assign({}, SEC_HEADERS, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  }, extraHeaders || {}));
  res.end(body);
}
function ok(res, data) { sendJSON(res, 200, data || { ok: true }); }
function fail(res, status, msg) { sendJSON(res, status, { error: msg }); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0, done = false;
    const finish = (val) => { if (!done) { done = true; clearTimeout(timer); resolve(val); } };
    const timer = setTimeout(() => { if (!done) { done = true; reject(new Error('请求超时')); } }, 10000);
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > 4 * 1024 * 1024) { done = true; clearTimeout(timer); reject(new Error('请求过大')); try { req.destroy(); } catch (_) {} return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return finish({});
      try {
        const v = JSON.parse(raw);
        // 拒绝数组/基本类型，统一按空对象处理，避免下游 .xxx 访问异常
        finish(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch (e) { finish({}); }
    });
    req.on('aborted', () => { if (!done) { done = true; clearTimeout(timer); reject(new Error('请求中断')); } });
    req.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
  });
}

// ---------------------------------------------------------------------------
// 静态文件
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.woff2': 'font/woff2',
  '.webp': 'image/webp'
};
function serveStatic(req, res, pathname) {
  if (pathname === '/' || pathname === '' || pathname === '/index.html') {
    try {
      const body = fs.readFileSync(INDEX_FILE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch (e) { fail(res, 500, '页面读取失败'); }
    return true;
  }
  // 站点图标：内联一个透明 favicon，避免浏览器产生 404 噪音
  if (pathname === '/favicon.ico') {
    res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'public, max-age=86400' });
    res.end(Buffer.from('AAABAAEAEBAAAAEAIABoBAAAFgAAACgAAAAQAAAAIAAAAAEAIAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAA=', 'base64'));
    return true;
  }
  // 版本检查文件：返回与页面一致的 build，避免触发"自动更新"重载
  if (pathname === '/version.json') {
    sendJSON(res, 200, { build: 'b5d8a56d6c73' });
    return true;
  }
  if (pathname === '/manifest.webmanifest') {
    sendJSON(res, 200, {
      name: 'Riposte: Frontline', short_name: 'Riposte', start_url: '/',
      display: 'standalone', background_color: '#0E110D', theme_color: '#0E110D',
      icons: []
    });
    return true;
  }
  // 什么都不做的分析脚本占位（页面会加载 /_vercel/insights/script.js）
  if (pathname === '/_vercel/insights/script.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end('/* offline */');
    return true;
  }
  // 仅允许读取项目内的静态资源
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (!rel) return false;
  const filePath = path.resolve(ROOT, rel);
  if (!filePath.startsWith(ROOT + path.sep)) { return false; }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    // 可选增强资源包（高清贴图 tex/、音效 sfx/）未随升级包提供时，返回优雅降级脚本：
    // 立即以 null 回调对应契约函数，避免 <script> onerror 触发页面左上角调试提示，
    // 也避免 fetchTexPack 等待 30 秒超时。若部署方放入真实资源包，则走下方正常静态服务，完全向前兼容。
    const mm = rel.match(/^(tex|sfx)\/([A-Za-z0-9_]+)\.[a-f0-9]{8}\.js$/);
    if (mm) {
      const fn = mm[1] === 'sfx' ? 'sfxPack' : 'texPack';
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=600' });
      res.end('try{' + fn + '(' + JSON.stringify(mm[2]) + ',null);}catch(e){}');
      return true;
    }
    return false;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

// ---------------------------------------------------------------------------
// 头像
// ---------------------------------------------------------------------------
function serveAvatar(req, res, query) {
  const name = query.get('u');
  let user = name ? findUserByLogin(name) : currentUser(req);
  if (!user || !user.avatar || !user.avatarFile) {
    res.writeHead(404); res.end(); return;
  }
  const fp = path.join(AVATAR_DIR, user.avatarFile);
  if (!fs.existsSync(fp)) { res.writeHead(404); res.end(); return; }
  const ext = path.extname(user.avatarFile).toLowerCase();
  res.writeHead(200, { 'Content-Type': ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png', 'Cache-Control': 'public, max-age=60' });
  fs.createReadStream(fp).pipe(res);
}
function saveAvatarData(user, dataURL) {
  const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/s.exec(String(dataURL || ''));
  if (!m) return false;
  let buf;
  try { buf = Buffer.from(m[2], 'base64'); } catch (e) { return false; }
  if (!buf.length || buf.length > 400 * 1024) return false;
  const ext = m[1] === 'png' ? 'png' : 'jpg';
  const file = normKey(user.username).replace(/[^a-z0-9_]/g, '') + '-' + Date.now() + '.' + ext;
  fs.writeFileSync(path.join(AVATAR_DIR, file), buf);
  if (user.avatarFile) {
    const old = path.join(AVATAR_DIR, user.avatarFile);
    try { if (fs.existsSync(old)) fs.unlinkSync(old); } catch (e) {}
  }
  user.avatarFile = file;
  user.avatar = (user.avatar || 0) + 1;
  save();
  return true;
}

// ---------------------------------------------------------------------------
// 对战结算：XP 计算（与单人模式 XP 减半规则一致）
// ---------------------------------------------------------------------------
function computeGain(summary) {
  const s = summary || {};
  const k = Math.max(0, s.kills | 0), d = Math.max(0, s.deaths | 0), a = Math.max(0, s.assists | 0);
  const hs = Math.max(0, s.headshots | 0), streak = Math.max(0, s.streak | 0);
  const win = s.result === 'win';
  let xp = 25 + k * 12 + a * 6 + hs * 3 + streak * 2 + Math.min(40, Math.floor((s.duration | 0) / 15));
  if (win) xp += 80;
  else if (s.result === 'draw') xp += 35;
  else if (s.result === 'loss') xp += 10;
  xp -= Math.min(60, d * 3);
  xp = Math.max(5, Math.round(xp));
  if (!s.online) xp = Math.max(3, Math.floor(xp / 2));
  return xp;
}

// ---------------------------------------------------------------------------
// API 路由
// ---------------------------------------------------------------------------
async function handleAPI(req, res, pathname, query, me, body) {
  const name = pathname.slice('/api/'.length).replace(/\/+$/, '');
  const method = req.method || 'GET';

  // -------- 账号：登录 / 注册 --------
  if (name === 'login' && method === 'POST') {
    const clip = String((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown');
    if (authLocked(clip)) return fail(res, 429, '尝试次数过多，请稍后再试');
    const user = findUserByLogin(body.login);
    if (!user || !checkPassword(user, body.password)) { authFail(clip); return fail(res, 401, '用户名或密码错误'); }
    if (user.banned) return fail(res, 403, '账号已被封禁');
    authOk(clip);
    issueSession(res, user, req);
    const data = accountPayload(user, user);
    if (!user.recoveryCode) { user.recoveryCode = randomCode(); saveNow(); data.recoveryCode = user.recoveryCode; }
    return ok(res, data);
  }
  if (name === 'register' && method === 'POST') {
    const username = cleanName(body.username);
    if (!validUsername(username)) return fail(res, 422, '用户名需为 2-16 位字母、数字或中文');
    if (findUserByLogin(username)) return fail(res, 409, '该用户名已被占用');
    if (String(body.password || '').length < 6) return fail(res, 422, '密码至少需要 6 位');
    if (body.accept === false) return fail(res, 422, '请先同意使用条款');
    const p = makePassword(body.password);
    const user = {
      id: newId(), username, displayName: username,
      salt: p.salt, passHash: p.passHash, recoveryCode: randomCode(),
      avatar: 0, moderator: false, banned: false,
      createdAt: new Date().toISOString(), xp: 0,
      stats: blankStats(), recent: [], arsenal: null,
      friends: [], sent: [], received: [], invites: [], notifications: []
    };
    db.users[username] = user;
    notify(user, 'welcome', null, {});
    saveNow();  // 新注册账号立即落盘，永久保存
    issueSession(res, user, req);
    const data = accountPayload(user, user);
    data.recoveryCode = user.recoveryCode;
    return ok(res, data);
  }

  // -------- 账号：资料（未登录 401） --------
  if (name === 'profile') {
    if (!me) return fail(res, 401, '未登录');
    if (method === 'POST') {
      if (body.displayName !== undefined) {
        const dn = String(body.displayName || '').trim().slice(0, 16);
        if (dn) { me.displayName = dn; save(); }
      }
      if (body.title !== undefined) {
        const t = String(body.title || '').trim().slice(0, 16);
        if (!validTitle(me, t)) return fail(res, 403, '无权使用该称号');
        me.title = t; save();
      }
    }
    return ok(res, accountPayload(me, me));
  }
  if (name === 'logout' && method === 'POST') {
    clearSession(req, res);
    return ok(res, {});
  }
  if (name === 'password-change' && method === 'POST') {
    if (!me) return fail(res, 401, '未登录');
    if (!checkPassword(me, body.current || '')) return fail(res, 422, '当前密码不正确');
    if (String(body.next || '').length < 6) return fail(res, 422, '新密码至少需要 6 位');
    const p = makePassword(body.next);
    me.salt = p.salt; me.passHash = p.passHash; me.recoveryCode = randomCode(); saveNow();
    const data = accountPayload(me, me); data.recoveryCode = me.recoveryCode;
    return ok(res, data);
  }
  if (name === 'password-recover' && method === 'POST') {
    const user = findUserByLogin(body.username);
    if (!user || String(body.code || '').trim().toUpperCase() !== String(user.recoveryCode || '').toUpperCase())
      return fail(res, 422, '用户名或恢复码不正确');
    if (String(body.password || '').length < 6) return fail(res, 422, '新密码至少需要 6 位');
    const p = makePassword(body.password);
    user.salt = p.salt; user.passHash = p.passHash; user.recoveryCode = randomCode(); saveNow();
    issueSession(res, user, req);
    const data = accountPayload(user, user); data.recoveryCode = user.recoveryCode;
    return ok(res, data);
  }
  if (name === 'recovery-new' && method === 'POST') {
    if (!me) return fail(res, 401, '未登录');
    if (String(body.password || '').length < 6) return fail(res, 422, '密码至少需要 6 位');
    const p = makePassword(body.password);
    me.salt = p.salt; me.passHash = p.passHash; me.recoveryCode = randomCode(); saveNow();
    const data = accountPayload(me, me); data.recoveryCode = me.recoveryCode;
    return ok(res, data);
  }
  if (name === 'recovery-ok' && method === 'POST') {
    const code = String(body.code || '').trim().toUpperCase();
    const user = Object.values(db.users).find((u) => String(u.recoveryCode || '').toUpperCase() === code);
    if (!user) return fail(res, 422, '恢复码无效');
    issueSession(res, user, req);
    return ok(res, accountPayload(user, user));
  }
  if (name === 'account-delete' && method === 'POST') {
    if (!me) return fail(res, 401, '未登录');
    if (!checkPassword(me, body.password || '')) return fail(res, 422, '密码不正确');
    clearSession(req, res);
    delete db.users[me.username];
    db.posts = db.posts.filter((p) => normKey(p.username) !== normKey(me.username));
    save();
    return ok(res, {});
  }
  if (name === 'account-export' && method === 'POST') {
    if (!me) return fail(res, 401, '未登录');
    const payload = JSON.stringify({ exportedAt: new Date().toISOString(), account: accountPayload(me, me), arsenal: me.arsenal || null, posts: db.posts.filter((p) => normKey(p.username) === normKey(me.username)) }, null, 2);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="riposte-frontline-mes-donnees.json"',
      'Content-Length': Buffer.byteLength(payload)
    });
    res.end(payload);
    return;
  }

  // -------- 头像 --------
  if (name === 'avatar' && method === 'GET') return serveAvatar(req, res, query);
  if (name === 'avatar-set' && method === 'POST') {
    if (!me) return fail(res, 401, '未登录');
    if (!saveAvatarData(me, body.image)) return fail(res, 422, '图片格式或大小不符合要求');
    return ok(res, accountPayload(me, me));
  }
  if (name === 'avatar-delete' && method === 'POST') {
    if (!me) return fail(res, 401, '未登录');
    if (me.avatarFile) {
      try { const fp = path.join(AVATAR_DIR, me.avatarFile); if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (e) {}
    }
    me.avatarFile = null; me.avatar = 0; save();
    return ok(res, accountPayload(me, me));
  }

  // -------- 军械库存档 --------
  if (name === 'arsenal') {
    if (!me) return fail(res, 401, '未登录');
    if (method === 'POST' && body.data !== undefined) { me.arsenal = body.data; save(); }
    return ok(res, { data: me.arsenal || null });
  }

  // -------- 对战 --------
  if (name === 'match-start' && method === 'POST') {
    if (!me) return fail(res, 401, '未登录');
    const token = crypto.randomBytes(16).toString('hex');
    db.matches[token] = { username: me.username, at: Date.now(), used: false };
    save();
    return ok(res, { token });
  }
  if (name === 'match-end' && method === 'POST') {
    if (!me) return fail(res, 401, '未登录');
    const rec = db.matches[body.token];
    if (!rec || rec.used || normKey(rec.username) !== normKey(me.username)) return fail(res, 422, '对局令牌无效');
    rec.used = true;
    const s = body.summary || {};
    const gained = computeGain(s);
    const before = levelOfXp(me.xp || 0);
    me.xp = (me.xp || 0) + gained;
    const st = me.stats || (me.stats = blankStats());
    st.matches += 1;
    st.kills += Math.max(0, s.kills | 0);
    st.deaths += Math.max(0, s.deaths | 0);
    st.assists += Math.max(0, s.assists | 0);
    st.headshots += Math.max(0, s.headshots | 0);
    st.hits += Math.max(0, s.hits | 0);
    st.shots += Math.max(0, s.shots | 0);
    st.seconds += Math.max(0, s.duration | 0);
    st.bestStreak = Math.max(st.bestStreak || 0, Math.max(0, s.streak | 0));
    if (s.result === 'win') st.wins += 1;
    if (!Array.isArray(me.recent)) me.recent = [];
    me.recent.unshift({
      map: String(s.map || ''), mode: String(s.mode || 'tdm'), result: String(s.result || ''),
      online: !!s.online, kills: Math.max(0, s.kills | 0), deaths: Math.max(0, s.deaths | 0),
      xp: gained, played_at: new Date().toISOString()
    });
    if (me.recent.length > 40) me.recent.length = 40;
    const after = levelOfXp(me.xp);
    const levelUp = after > before;
    if (levelUp) notify(me, 'levelup', null, { level: after });
    save();
    return ok(res, {
      level: levelObject(me.xp), stats: me.stats, recent: me.recent,
      gained, levelUp
    });
  }
  if (name === 'beat' && method === 'POST') {
    // 未登录用户的匿名心跳（用于在线统计占位）
    return ok(res, {});
  }
  if (name === 'presence' && method === 'POST') {
    if (!me) return fail(res, 401, '未登录');
    me.online = true;
    me.state = String(body.s || 'menu');
    me.lastSeen = Date.now();
    // 过期在线状态清理
    const now = Date.now();
    Object.values(db.users).forEach((u) => { if (u.online && now - (u.lastSeen || 0) > 90000) u.online = false; });
    save();
    const invites = (me.invites || []).filter((i) => now - i.at < 120000).map((i) => {
      const from = db.users[i.from];
      return { id: i.id, code: i.code, from: { displayName: from ? from.displayName : i.from } };
    });
    return ok(res, { invites, unread: unreadCount(me) });
  }

  // -------- 排行榜 --------
  if (name === 'leaderboard' && method === 'GET') {
    if (!me) return fail(res, 401, '未登录');
    const scope = query.get('scope') || 'all';
    const offset = Math.max(0, parseInt(query.get('offset') || '0', 10) || 0);
    const q = String(query.get('q') || '').trim().toLowerCase();
    let list = Object.values(db.users).filter((u) => !u.banned);
    if (scope === 'friends') {
      const friends = (me.friends || []).map(normKey);
      list = list.filter((u) => normKey(u.username) === normKey(me.username) || friends.includes(normKey(u.username)));
    }
    if (q) list = list.filter((u) => normKey(u.username).includes(q) || normKey(u.displayName).includes(q));
    list.sort((a, b) => (b.xp || 0) - (a.xp || 0) || normKey(a.username).localeCompare(normKey(b.username)));
    const total = list.length;
    const slice = list.slice(offset, offset + 20);
    const meRank = list.findIndex((u) => normKey(u.username) === normKey(me.username)) + 1;
    const players = slice.map((u, i) => {
      const st = u.stats || blankStats();
      const kd = st.deaths ? st.kills / st.deaths : st.kills;
      return {
        rank: offset + i + 1, username: u.username, displayName: u.displayName || u.username,
        avatar: u.avatar || 0, level: levelObject(u.xp).level, xp: u.xp || 0,
        kd: Math.round(kd * 100) / 100, relation: relation(me, u)
      };
    });
    return ok(res, { players, more: offset + slice.length < total, me: { rank: meRank, total } });
  }

  // -------- 玩家资料 --------
  if (name === 'player' && method === 'GET') {
    if (!me) return fail(res, 401, '未登录');
    const user = findUserByLogin(query.get('u'));
    if (!user) return fail(res, 404, '找不到该玩家');
    const data = accountPayload(user, me);
    data.relation = relation(me, user);
    return ok(res, data);
  }

  // -------- 好友 --------
  if (name === 'friends' && method === 'GET') {
    if (!me) return fail(res, 401, '未登录');
    const map = (arr) => arr.map((n) => db.users[n]).filter(Boolean).map((u) => shortUser(u, me));
    return ok(res, {
      friends: map(me.friends || []),
      received: map(me.received || []),
      sent: map(me.sent || [])
    });
  }
  if (name === 'friend-request' && method === 'POST') {
    if (!me) return fail(res, 401, '未登录');
    const target = findUserByLogin(body.username);
    if (!target) return fail(res, 404, '找不到该玩家');
    if (normKey(target.username) === normKey(me.username)) return fail(res, 422, '不能添加自己为好友');
    const rel = relation(me, target);
    if (rel === 'friend') return ok(res, { relation: 'friend' });
    if (rel === 'sent') return ok(res, { relation: 'sent' });
    if (rel === 'received') {
      // 对方已请求 → 直接互相成为好友
      me.received = removeFrom(me.received, target.username);
      target.sent = removeFrom(target.sent, me.username);
      addUnique(me.friends, target.username); addUnique(target.friends, me.username);
      notify(target, 'friend_accepted', me, {});
      save();
      return ok(res, { relation: 'friend' });
    }
    addUnique(me.sent, target.username);
    addUnique(target.received, me.username);
    notify(target, 'friend_request', me, {});
    save();
    return ok(res, { relation: 'sent' });
  }
  if (name === 'friend-respond' && method === 'POST') {
    if (!me) return fail(res, 401, '未登录');
    const target = findUserByLogin(body.username);
    if (!target) return fail(res, 404, '找不到该玩家');
    if (!body.accept) {
      me.received = removeFrom(me.received, target.username);
      target.sent = removeFrom(target.sent, me.username);
      save();
      return ok(res, { relation: 'none' });
    }
    me.received = removeFrom(me.received, target.username);
    target.sent = removeFrom(target.sent, me.username);
    addUnique(me.friends, target.username); addUnique(target.friends, me.username);
    notify(target, 'friend_accepted', me, {});
    save();
    return ok(res, { relation: 'friend' });
  }
  if (name === 'friend-remove' && method === 'POST') {
    if (!me) return fail(res, 401, '未登录');
    const target = findUserByLogin(body.username);
    if (!target) return ok(res, { relation: 'none' });
    me.friends = removeFrom(me.friends, target.username);
    me.sent = removeFrom(me.sent, target.username);
    me.received = removeFrom(me.received, target.username);
    target.friends = removeFrom(target.friends, me.username);
    target.sent = removeFrom(target.sent, me.username);
    target.received = removeFrom(target.received, me.username);
    save();
    return ok(res, { relation: 'none' });
  }

  // -------- 通知 --------
  if (name === 'notifications' && method === 'GET') {
    if (!me) return fail(res, 401, '未登录');
    return ok(res, { unread: unreadCount(me), items: me.notifications || [] });
  }
  if (name === 'notifications-read' && method === 'POST') {
    if (!me) return fail(res, 401, '未登录');
    if (body.clear) me.notifications = [];
    else (me.notifications || []).forEach((n) => { n.read = true; });
    save();
    return ok(res, {});
  }

  // -------- 大厅邀请 --------
  if (name === 'salon-invite' && method === 'POST') {
    if (!me) return fail(res, 401, '未登录');
    const target = findUserByLogin(body.username);
    if (!target) return fail(res, 404, '找不到该玩家');
    const raw = String(body.code || '').trim();
    // 公共房间号形如 abc7（小写字母+数字），对局码形如 A1B2C（5 位大写）；两种都要接受
    const isRoomId = /^[a-z]{3}[0-9]{1,2}$/i.test(raw);
    const code = isRoomId ? raw.toLowerCase() : raw.toUpperCase();
    if (!isRoomId && !/^[A-Z0-9]{5}$/.test(code)) return fail(res, 422, '邀请码无效');
    if (relation(me, target) !== 'friend') return fail(res, 403, '只能邀请好友');
    const id = newId();
    if (!Array.isArray(target.invites)) target.invites = [];
    target.invites.unshift({ id, from: me.username, code, at: Date.now() });
    target.invites = target.invites.slice(0, 20);
    notify(target, 'salon_invite', me, { code });
    save();
    return ok(res, {});
  }
  if (name === 'invite-answer' && method === 'POST') {
    if (!me) return fail(res, 401, '未登录');
    me.invites = (me.invites || []).filter((i) => String(i.id) !== String(body.id));
    save();
    return ok(res, {});
  }

  // -------- 举报与审核 --------
  if (name === 'report' && method === 'POST') {
    if (!me) return fail(res, 401, '未登录');
    const target = findUserByLogin(body.username);
    if (!target) return fail(res, 404, '找不到该玩家');
    db.reports.push({
      id: newId(), from: me.username, username: target.username,
      reason: String(body.reason || ''), note: String(body.note || '').slice(0, 300),
      at: Date.now(), resolved: false
    });
    save();
    return ok(res, {});
  }
  if (name === 'mod-list' && method === 'GET') {
    if (!me || !me.moderator) return fail(res, 403, '无权限');
    const view = query.get('view');
    let reports = db.reports;
    if (view === 'blocked') reports = reports.filter((r) => r.action === 'block');
    else reports = reports.filter((r) => !r.resolved);
    const grouped = {};
    reports.forEach((r) => {
      const key = normKey(r.username);
      if (!grouped[key]) {
        const u = db.users[r.username] || findUserByLogin(r.username);
        grouped[key] = {
          username: u ? u.username : r.username,
          displayName: u ? (u.displayName || u.username) : r.username,
          avatar: u ? (u.avatar || 0) : 0,
          avatarHidden: !!(u && u.avatarHidden) || r.reason === 'photo',
          level: u ? levelOfXp(u.xp || 0) : 1,
          createdAt: u ? (u.createdAt || '') : '',
          blockedAt: u ? (u.blockedAt || '') : '',
          removed: !!(u && u.removed),
          reasons: {},
          notes: [],
          stats: u ? Object.assign(blankStats(), u.stats) : blankStats()
        };
      }
      const g = grouped[key];
      const reason = r.reason || '其他';
      g.reasons[reason] = (g.reasons[reason] || 0) + 1;
      // 前端 modRender() 依赖 notes 数组逐条渲染举报详情，缺失会导致 .map() 抛错
      g.notes.push({ by: r.from || '?', reason, at: r.at || Date.now(), note: r.note || '' });
    });
    return ok(res, { accounts: Object.values(grouped), open: openReportCount() });
  }
  if (name === 'mod-action' && method === 'POST') {
    if (!me || !me.moderator) return fail(res, 403, '无权限');
    const target = findUserByLogin(body.username);
    if (!target) return fail(res, 404, '找不到该玩家');
    const action = String(body.action || '');
    if (action === 'block') {
      target.banned = true; target.blockedAt = Date.now();
      // 封禁同时踢掉该账号所有会话，令其所有设备立即掉线
      for (const [sid, name] of Object.entries(db.sessions)) {
        if (normKey(name) === normKey(target.username)) delete db.sessions[sid];
      }
      db.reports.forEach((r) => { if (normKey(r.username) === normKey(target.username)) { r.action = 'block'; r.resolved = true; } });
    } else if (action === 'unblock') {
      target.banned = false; target.blockedAt = '';
      db.reports.forEach((r) => { if (normKey(r.username) === normKey(target.username)) { r.resolved = true; r.action = 'unblock'; } });
    } else if (action === 'ignore') {
      db.reports.forEach((r) => { if (normKey(r.username) === normKey(target.username)) r.resolved = true; });
    } else if (action === 'photo') {
      target.avatar = 0; target.avatarHidden = false; notify(target, 'mod_photo', me, {});
      db.reports.forEach((r) => { if (normKey(r.username) === normKey(target.username) && r.reason === 'photo') r.resolved = true; });
    } else if (action === 'name') {
      target.displayName = target.username;
      if (target.title && target.title !== DEV_TITLE && !validTitle(target, target.title)) target.title = '';
      notify(target, 'mod_name', me, {});
      db.reports.forEach((r) => { if (normKey(r.username) === normKey(target.username) && r.reason === 'nom') r.resolved = true; });
    } else if (action === 'board') {
      target.removed = true; notify(target, 'mod_board', me, {});
      db.reports.forEach((r) => { if (normKey(r.username) === normKey(target.username) && r.reason === 'triche') r.resolved = true; });
    } else return fail(res, 422, '未知操作');
    save();
    return ok(res, {});
  }

  // -------- 社区 --------
  if (name === 'community' && method === 'GET') {
    const kind = query.get('kind') || 'avis';
    const view = query.get('view');
    const sort = query.get('sort') || 'top';
    const offset = Math.max(0, parseInt(query.get('offset') || '0', 10) || 0);
    const isMod = !!(me && me.moderator);
    let list = db.posts.filter((p) => {
      if (view === 'reported') return (p.flaggedBy || []).length > 0 && (isMod || (me && normKey(p.username) === normKey(me.username)));
      return p.kind === kind && !p.hidden;
    });
    if (sort === 'new') list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    else list.sort((a, b) => ((b.votes || []).length - (a.votes || []).length) || b.createdAt.localeCompare(a.createdAt));
    const total = list.length;
    const slice = list.slice(offset, offset + 20);
    const avis = db.posts.filter((p) => p.kind === 'avis' && !p.hidden);
    const sumRatings = avis.reduce((n, p) => n + (p.rating || 0), 0);
    const myReviewRec = me ? avis.find((p) => normKey(p.username) === normKey(me.username)) : null;
    return ok(res, {
      posts: slice.map((p) => postView(p, me)),
      more: offset + slice.length < total,
      summary: { count: avis.length, avg: avis.length ? sumRatings / avis.length : 0 },
      myReview: myReviewRec ? { id: myReviewRec.id, body: myReviewRec.body, rating: myReviewRec.rating } : null,
      canReview: !!(me && ((me.stats && me.stats.matches) || 0) > 0),
      mod: isMod,
      reported: db.posts.filter((p) => (p.flaggedBy || []).length > 0).length
    });
  }
  if (name === 'community-post' && method === 'POST') {
    if (!me) return fail(res, 401, '未登录');
    const kind = ['avis', 'idee', 'bug'].includes(body.kind) ? body.kind : 'idee';
    const text = String(body.body || '').trim();
    if (!text || text.length > COMMENT_MAX) return fail(res, 422, `内容需在 1-${COMMENT_MAX} 字之间`);
    const rating = kind === 'avis' ? Math.max(1, Math.min(5, body.rating | 0)) : 0;
    if (kind === 'avis') {
      // 评价：每人一条
      const existing = db.posts.find((p) => p.kind === 'avis' && normKey(p.username) === normKey(me.username));
      if (existing) {
        existing.body = text; existing.rating = rating; existing.createdAt = new Date().toISOString();
        if (existing.hidden) existing.hidden = false;
        save();
        return ok(res, { id: existing.id });
      }
    } else if (body.id) {
      const existing = db.posts.find((p) => String(p.id) === String(body.id) && normKey(p.username) === normKey(me.username));
      if (!existing) return fail(res, 403, '无权修改');
      existing.body = text; existing.createdAt = new Date().toISOString(); save();
      return ok(res, { id: existing.id });
    }
    const post = {
      id: newId(), kind, body: text, rating, username: me.username,
      createdAt: new Date().toISOString(), votes: [], flaggedBy: [],
      hidden: false, status: '', reply: ''
    };
    db.posts.push(post);
    save();
    return ok(res, { id: post.id });
  }
  if (name === 'community-vote' && method === 'POST') {
    if (!me) return fail(res, 401, '未登录');
    const p = db.posts.find((x) => String(x.id) === String(body.id));
    if (!p) return fail(res, 404, '内容不存在');
    p.votes = p.votes || [];
    const i = p.votes.findIndex((x) => normKey(x) === normKey(me.username));
    if (i >= 0) p.votes.splice(i, 1); else p.votes.push(me.username);
    save();
    return ok(res, { voted: i < 0, votes: p.votes.length });
  }
  if (name === 'community-report' && method === 'POST') {
    if (!me) return fail(res, 401, '未登录');
    const p = db.posts.find((x) => String(x.id) === String(body.id));
    if (!p) return fail(res, 404, '内容不存在');
    p.flaggedBy = p.flaggedBy || [];
    addUnique(p.flaggedBy, me.username);
    save();
    return ok(res, {});
  }
  if (name === 'community-delete' && method === 'POST') {
    if (!me) return fail(res, 401, '未登录');
    const p = db.posts.find((x) => String(x.id) === String(body.id));
    if (!p) return ok(res, {});
    if (normKey(p.username) !== normKey(me.username) && !me.moderator) return fail(res, 403, '无权删除');
    db.posts = db.posts.filter((x) => String(x.id) !== String(body.id));
    save();
    return ok(res, {});
  }
  if (name === 'community-mod' && method === 'POST') {
    if (!me || !me.moderator) return fail(res, 403, '无权限');
    const p = db.posts.find((x) => String(x.id) === String(body.id));
    if (!p) return fail(res, 404, '内容不存在');
    const action = String(body.action || '');
    if (action === 'hide') p.hidden = true;
    else if (action === 'show') p.hidden = false;
    else if (action === 'answer') { p.status = body.status || null; p.reply = String(body.reply || '').slice(0, COMMENT_MAX); }
    else if (action === 'clear') p.flaggedBy = [];
    else return fail(res, 422, '未知操作');
    save();
    return ok(res, {});
  }

  return fail(res, 404, '接口不存在');
}

// ---------------------------------------------------------------------------
// 请求入口
// ---------------------------------------------------------------------------
// 简单 IP 级限流：每个 IP 每秒最多 N 个 API 请求，防止滥用/刷接口拖垮服务
const RATE_WINDOW = 1000, RATE_MAX = 120;
const rateMap = new Map();
function rateAllowed(ip) {
  const now = Date.now();
  let e = rateMap.get(ip);
  if (!e || now - e.t > RATE_WINDOW) { e = { t: now, n: 0 }; rateMap.set(ip, e); }
  e.n++;
  return e.n <= RATE_MAX;
}
// 定期清理限流表，避免无界增长
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of rateMap) if (now - e.t > RATE_WINDOW * 5) rateMap.delete(ip);
  for (const [ip, e] of authFails) if (now - e.until > 0) authFails.delete(ip);
}, 30000).unref?.();

// ---- 认证防暴破：同一 IP 连续登录失败会临时锁定 ----
const authFails = new Map();  // ip -> { n, until }
function authLocked(ip) { const e = authFails.get(ip); return !!(e && e.until > Date.now()); }
function authFail(ip) {
  const now = Date.now();
  let e = authFails.get(ip);
  if (!e || e.until <= now) e = { n: 0, until: 0 };
  e.n++;
  if (e.n >= 8) { e.until = now + 60000; e.n = 0; }  // 8 次失败锁 60 秒
  authFails.set(ip, e);
}
function authOk(ip) { authFails.delete(ip); }

const server = http.createServer(async (req, res) => {
  // 请求级兜底：任何异常都不应导致进程退出
  try {
    const parsed = new URL(req.url || '/', 'http://localhost');
    const pathname = parsed.pathname;

    // 健康检查（无需鉴权，便于监控与探活）
    if (pathname === '/api/health') {
      return sendJSON(res, 200, { ok: true, status: 'healthy', uptime: Math.floor(process.uptime()), users: Object.keys(db.users).length });
    }

    // 联机中继：公开大厅列表（客户端 netPubFetch 读取）
    if (pathname === '/salons') {
      return sendJSON(res, 200, relay.salonsData());
    }
    // 客户端 RTT 探活（netRttProbe）
    if (pathname === '/sante') {
      return sendJSON(res, 200, { ok: true, t: Date.now() });
    }

    if (!pathname.startsWith('/api/')) {
      if (serveStatic(req, res, pathname)) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    // API 限流
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    if (!rateAllowed(ip)) return fail(res, 429, '请求过于频繁，请稍后重试');

    const me = currentUser(req);
    const body = (req.method === 'POST' || req.method === 'PUT') ? await readBody(req) : {};
    await handleAPI(req, res, pathname, parsed.searchParams, me, body);
  } catch (e) {
    const msg = (e && e.message) || '';
    // 客户端侧错误（超大请求/超时/中断）属预期防护，简记一行即可
    if (/请求过大|请求超时|请求中断/.test(msg)) console.warn('[请求拒绝]', msg);
    else console.error('[请求异常]', e && e.stack || e);
    if (!res.headersSent) {
      const status = /请求过大/.test(msg) ? 413 : /请求超时|请求中断/.test(msg) ? 408 : 500;
      fail(res, status, status === 413 ? '请求体过大' : status === 408 ? '请求超时' : '服务器内部错误');
    } else try { res.end(); } catch (_) {}
  }
});

// ---- 稳定性：超时控制，防止慢连接/挂起请求耗尽资源 ----
server.headersTimeout = 20000;      // 接收请求头超时
server.requestTimeout = 30000;      // 接收完整请求超时
server.keepAliveTimeout = 5000;     // keep-alive 空闲超时
server.timeout = 60000;             //  socket 空闲超时
server.on('clientError', (err, socket) => {
  try { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (_) {}
});

// ---- 联机中继：WebSocket 升级处理（协议13：/serveur、/room）----
relay.attach(server);

// ---- 稳定性：进程级兜底，避免意外异常导致服务中断 ----
process.on('uncaughtException', (err) => { console.error('[未捕获异常]', err && err.stack || err); });
process.on('unhandledRejection', (err) => { console.error('[未处理拒绝]', err && err.stack || err); });

// ---- 稳定性：定期自动存档（防止异常退出丢失数据） ----
const AUTO_SAVE = setInterval(() => { try { saveNow(); } catch (_) {} }, 15000);
AUTO_SAVE.unref?.();

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${signal}] 正在保存数据并关闭服务器...`);
  try { saveNow(); } catch (_) {}
  server.close(() => { console.log('[关闭完成]'); process.exit(0); });
  setTimeout(() => { process.exit(0); }, 3000).unref?.();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, HOST, () => {
  console.log('============================================================');
  console.log('  Riposte: Frontline 正式版 v3.0.0 —— 服务器已启动');
  console.log(`  访问地址: http://localhost:${PORT}`);
  console.log('  开发者账号: 123456 / 123456');
  console.log(`  数据目录: ${DATA_DIR}`);
  console.log('  健康检查: /api/health');
  console.log('============================================================');
});
