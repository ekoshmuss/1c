// Вход по логину и паролю для веб-интерфейса (без внешних пакетов)
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const USERS_FILE = path.join(__dirname, 'data', 'users.json');
const SESSION_HOURS = 12;
const MAX_FAILS = 10;           // неудачных попыток с одного адреса
const FAIL_WINDOW_MIN = 15;     // за столько минут → временная блокировка

// ---------- Пользователи ----------
function readUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return {}; }
}
function writeUsers(users) {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), 'utf8');
  fs.renameSync(tmp, USERS_FILE);
}
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function checkPassword(user, password) {
  if (!user) {
    hashPassword(password); // одинаковое время ответа для несуществующего логина
    return false;
  }
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}

// ---------- Сессии ----------
const sessions = new Map(); // token -> { user, role, name, exp }
const fails = new Map();    // ip -> [timestamps]

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function clientIp(req, trustProxy) {
  if (trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',').pop().trim();
  return req.socket.remoteAddress || '';
}
function isHttps(req, trustProxy) {
  return trustProxy && String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
}
function getSession(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(token); return null; }
  return s;
}
function isBlocked(ip) {
  const now = Date.now();
  const list = (fails.get(ip) || []).filter((t) => now - t < FAIL_WINDOW_MIN * 60000);
  fails.set(ip, list);
  return list.length >= MAX_FAILS;
}
function login(req, username, password, opts) {
  const ip = clientIp(req, opts.trustProxy);
  if (isBlocked(ip)) return { error: `Слишком много неудачных попыток. Попробуйте через ${FAIL_WINDOW_MIN} минут.`, status: 429 };
  const users = readUsers();
  const key = String(username || '').trim().toLowerCase();
  const user = users[key];
  const ok = checkPassword(user, password) && !user.disabled;
  if (!ok) {
    fails.get(ip).push(Date.now());
    console.warn(new Date().toISOString(), `Неудачный вход: "${key}" с ${ip}`);
    return { error: 'Неверный логин или пароль', status: 401 };
  }
  fails.delete(ip);
  try { user.last = new Date().toISOString(); writeUsers(users); } catch { /* не критично */ }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { user: key, name: user.name || key, role: user.role || 'viewer', exp: Date.now() + SESSION_HOURS * 3600000 });
  console.log(new Date().toISOString(), `Вход: "${key}" с ${ip}`);
  const secure = isHttps(req, opts.trustProxy) || opts.cookieSecure ? '; Secure' : '';
  return { cookie: `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}` };
}
function logout(req) {
  const token = parseCookies(req).sid;
  if (token) sessions.delete(token);
  return 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';
}
// завершить все сессии пользователя (при блокировке / смене роли)
function dropSessions(login) {
  for (const [t, s] of sessions) if (s.user === login) sessions.delete(t);
}
// периодическая очистка
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.exp < now) sessions.delete(t);
}, 3600000).unref();

module.exports = { readUsers, writeUsers, hashPassword, checkPassword, getSession, login, logout, dropSessions, USERS_FILE };
