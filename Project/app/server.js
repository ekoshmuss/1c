// Веб-интерфейс остатков медикаментов и реагентов (интеграция с 1С)
// Запуск: node server.js   (Node.js 18+; внешние пакеты не нужны)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const auth = require('./auth');

// ---------- Настройки (файл .env рядом с server.js) ----------
function loadEnv() {
  const file = path.join(__dirname, '.env');
  const env = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return { ...env, ...process.env };
}
const env = loadEnv();
const CFG = {
  port: Number(env.PORT || 8080),
  onecUrl: (env.ONEC_URL || 'http://192.168.2.3:6536/vigruzki/hs/labstock').replace(/\/$/, ''),
  onecUser: env.ONEC_USER || '',
  onecPass: env.ONEC_PASS || '',
  cacheSeconds: Number(env.CACHE_SECONDS || 15),
  // Склады, которые показывает интерфейс (начало наименования, через запятую)
  warehouses: (env.WAREHOUSES || '018,023').split(',').map((x) => x.trim()).filter(Boolean).join(','),
  defaultWarehouse: env.DEFAULT_WAREHOUSE || '018',
  expiryWarnDays: Number(env.EXPIRY_WARN_DAYS || 60),
  redPct: Number(env.RED_PCT || 20),
  yellowPct: Number(env.YELLOW_PCT || 50),
  host: env.HOST || '0.0.0.0',
  // TRUST_PROXY=1, если сайт открывается через IIS/nginx (обратный прокси) по домену
  trustProxy: env.TRUST_PROXY === '1',
  cookieSecure: env.COOKIE_SECURE === '1',
};
const NORMS_FILE = path.join(__dirname, 'data', 'norms.json');
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');

// ---------- Пороги (меняются в интерфейсе, хранятся в data/settings.json) ----------
function getSettings() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { /* по умолчанию из .env */ }
  return { red: Number(s.red) || CFG.redPct, yellow: Number(s.yellow) || CFG.yellowPct, exp: Number(s.exp) || CFG.expiryWarnDays };
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8');
}
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- Нормы запаса ----------
function readNorms() {
  try { return JSON.parse(fs.readFileSync(NORMS_FILE, 'utf8')); } catch { return {}; }
}
function writeNorms(norms) {
  fs.mkdirSync(path.dirname(NORMS_FILE), { recursive: true });
  const tmp = NORMS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(norms, null, 2), 'utf8');
  fs.renameSync(tmp, NORMS_FILE);
}
const normKey = (warehouse, code) => `${warehouse}|${code}`;

// ---------- Получение данных из 1С ----------
let cache = { at: 0, data: null };
async function onecGet(method, optional = false, extra = '') {
  const headers = { Accept: 'application/json' };
  if (CFG.onecUser) {
    headers.Authorization = 'Basic ' + Buffer.from(`${CFG.onecUser}:${CFG.onecPass}`, 'utf8').toString('base64');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  let res;
  try {
    res = await fetch(`${CFG.onecUrl}/${method}?wh=${encodeURIComponent(CFG.warehouses)}${extra}`, { headers, signal: ctrl.signal });
  } catch (e) {
    throw new Error('Нет связи с 1С: ' + (e.name === 'AbortError' ? 'превышено время ожидания' : e.message));
  } finally { clearTimeout(timer); }
  const text = await res.text();
  if (res.status === 401) throw new Error('1С отклонила логин/пароль (проверьте ONEC_USER / ONEC_PASS в .env)');
  if (res.status === 404) { if (optional) return null; throw new Error(`В 1С нет метода /${method} — обновите расширение LabStock`); }
  let json;
  try { json = JSON.parse(text.replace(/^﻿/, '')); } catch { throw new Error(`1С вернула не JSON (HTTP ${res.status})`); }
  if (json.error) throw new Error('Ошибка 1С: ' + json.error);
  return json;
}
async function fetchStock(force = false, date = '') {
  if (date && date !== todayIso()) {
    // отчёт на прошлую дату — без кэша
    const d = '&date=' + encodeURIComponent(date);
    const [stock, receipts] = await Promise.all([onecGet('stock', false, d), onecGet('receipts', false, d)]);
    return { ...stock, receipts: receipts.items || [], usage: null, at: Date.now() };
  }
  if (!force && cache.data && Date.now() - cache.at < CFG.cacheSeconds * 1000) return cache.data;
  const [stock, receipts, usage] = await Promise.all([
    onecGet('stock'), onecGet('receipts'),
    onecGet('usage', true, '&days=30').catch((e) => { console.warn('usage:', e.message); return null; }),
  ]);
  cache = { at: Date.now(), data: { ...stock, receipts: receipts.items || [], usage: usage ? usage.items || [] : null } };
  return cache.data;
}

// ---------- Расчёт ----------
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
// Дата из 1С приходит без часового пояса ("2026-12-10T00:00:00") — берём только дату, без сдвига по поясу
function parseExpiry(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m || m[1] === '0001') return null;
  return m[0];
}
const dayNum = (iso) => Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000);
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function buildItems(raw, norms) {
  const today = dayNum(todayIso());
  const T = getSettings();
  const usage = new Map();
  for (const u of raw.usage || []) {
    const k = normKey(clean(u['Склад']), clean(u['Код']));
    usage.set(k, (usage.get(k) || 0) + (Number(u['Количество']) || 0));
  }
  const map = new Map();
  for (const r of raw.items || []) {
    const warehouse = clean(r['Склад']);
    const code = clean(r['Код']);
    const key = normKey(warehouse, code);
    let it = map.get(key);
    if (!it) {
      it = {
        key, warehouse, code,
        name: clean(r['Наименование']), group: clean(r['Группа']),
        unit: clean(r['ЕдиницаИзмерения']),
        qty: 0, sum: 0, series: [], nearestExpiry: null,
      };
      map.set(key, it);
    }
    const qty = Number(r['Количество']) || 0;
    it.qty += qty;
    it.sum += Number(r['Сумма']) || 0;
    const exp = parseExpiry(r['СрокГодности']);
    it.series.push({ series: clean(r['Серия']), qty, expiry: exp });
    if (exp && qty > 0 && (!it.nearestExpiry || exp < it.nearestExpiry)) it.nearestExpiry = exp;
  }
  // последнее поступление = 100%
  const receipts = new Map();
  for (const r of raw.receipts || []) {
    const key = normKey(clean(r['Склад']), clean(r['Код']));
    const prev = receipts.get(key);
    const date = parseExpiry(r['Дата']);
    const qty = Number(r['Количество']) || 0;
    if (prev && prev.date === date) { prev.qty += qty; prev.doc += '; ' + clean(r['Документ']); }
    else if (!prev || date > prev.date) receipts.set(key, { date, qty, doc: clean(r['Документ']) });
  }
  const out = [];
  for (const it of map.values()) {
    const rc = receipts.get(it.key);
    it.receiptQty = rc ? Math.round(rc.qty * 1000) / 1000 : null;
    it.receiptDate = rc ? rc.date : null;
    it.receiptDoc = rc ? rc.doc : null;
    it.qty = Math.round(it.qty * 1000) / 1000;
    it.sum = Math.round(it.sum * 100) / 100;
    // норма: ручная (если задана администратором) или последнее поступление
    const manual = Number(norms[it.key]) || null;
    const norm = manual || (it.receiptQty > 0 ? it.receiptQty : null);
    it.norm = norm;
    it.normSource = manual ? 'manual' : norm ? 'receipt' : null;
    it.pct = norm ? Math.round((it.qty / norm) * 1000) / 10 : null;
    if (it.qty < 0) it.status = 'error';
    else if (!norm) it.status = 'nonorm';
    else if (it.pct < T.red) it.status = 'red';
    else if (it.pct < T.yellow) it.status = 'yellow';
    else it.status = 'green';
    if (it.qty < 0) it.pct = null;
    it.orderQty = norm && ['red', 'yellow', 'error'].includes(it.status) ? Math.ceil(norm - Math.max(it.qty, 0)) : 0;
    if (it.nearestExpiry) {
      const days = dayNum(it.nearestExpiry) - today;
      it.expiry = it.nearestExpiry;
      it.expiryDays = days;
      it.expiryStatus = days < 0 ? 'expired' : days <= T.exp ? 'soon' : 'ok';
    } else { it.expiry = null; it.expiryDays = null; it.expiryStatus = null; }
    delete it.nearestExpiry;
    it.used30 = raw.usage ? Math.round((usage.get(it.key) || 0) * 1000) / 1000 : null;
    for (const sr of it.series) sr.days = sr.expiry ? dayNum(sr.expiry) - today : null;
    out.push(it);
  }
  return out;
}

async function getView(query) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(query.get('date') || '') ? query.get('date') : '';
  const raw = await fetchStock(query.get('refresh') === '1', date);
  const all = buildItems(raw, readNorms());
  const warehouses = [...new Set(all.map((i) => i.warehouse))].sort((a, b) => a.localeCompare(b, 'ru'));
  let wh = query.get('warehouse');
  if (wh == null) wh = warehouses.find((w) => w.toLowerCase().startsWith(CFG.defaultWarehouse.toLowerCase())) || warehouses[0] || '';
  const items = wh ? all.filter((i) => i.warehouse === wh) : all;
  return {
    syncedAt: new Date(raw.at || cache.at).toISOString(),
    date: date || todayIso(),
    onecDate: raw.date,
    warehouse: wh,
    warehouses,
    thresholds: (() => { const t = getSettings(); return { red: t.red, yellow: t.yellow, expiryWarnDays: t.exp }; })(),
    usageAvailable: raw.usage != null,
    onecUrl: CFG.onecUrl, onecUser: CFG.onecUser, warehouseCodes: CFG.warehouses,
    items,
  };
}

// ---------- Отчёт CSV (открывается в Excel) ----------
const STATUS_RU = { red: 'Мало — заказать', yellow: 'Меньше среднего', green: 'Достаточно', nonorm: 'Нет поступлений', error: 'Отрицательный остаток' };
function toCsv(view, onlyOrder) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const num = (v) => (v == null ? '' : String(v).replace('.', ','));
  const rows = [['Склад', 'Код', 'Наименование', 'Группа', 'Ед.', 'Остаток', 'Последнее поступление', 'Дата поступления', 'Норма (100%)', 'Уровень, %', 'Статус', 'К заказу', 'Ближайший срок годности', 'Сумма']];
  let items = view.items;
  if (onlyOrder) items = items.filter((i) => i.status === 'red' || i.status === 'yellow');
  for (const i of items) {
    rows.push([i.warehouse, i.code, i.name, i.group, i.unit, num(i.qty), num(i.receiptQty), i.receiptDate || '', num(i.norm), num(i.pct), STATUS_RU[i.status], num(i.orderQty || ''), i.expiry || '', num(i.sum)]);
  }
  return '﻿' + rows.map((r) => r.map(esc).join(';')).join('\r\n');
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
};
function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
async function jsonBody(req) {
  try { return JSON.parse((await readBody(req)) || '{}'); } catch { return {}; }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    // ---- вход / выход (доступны без входа) ----
    if (url.pathname === '/api/login' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* пусто */ }
      const r = auth.login(req, body.username, body.password, CFG);
      if (r.error) return send(res, r.status, { error: r.error });
      return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': r.cookie });
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': auth.logout(req) });
    }
    if (url.pathname === '/login.html' || url.pathname === '/favicon.ico' || url.pathname.startsWith('/fonts/') || url.pathname === '/app.css' || url.pathname === '/logo.jpg' || url.pathname === '/favicon.png') {
      const f = path.normalize(path.join(PUBLIC_DIR, url.pathname));
      if (!f.startsWith(PUBLIC_DIR) || !fs.existsSync(f)) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
      return send(res, 200, fs.readFileSync(f), MIME[path.extname(f)] || 'application/octet-stream', url.pathname.startsWith('/fonts/') ? { 'Cache-Control': 'public, max-age=31536000' } : {});
    }
    // ---- всё остальное — только после входа ----
    const session = auth.getSession(req);
    if (!session) {
      if (url.pathname.startsWith('/api/')) return send(res, 401, { error: 'Требуется вход' });
      res.writeHead(302, { Location: '/login.html', 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (url.pathname === '/api/me') return send(res, 200, { user: session.user, name: session.name, role: session.role, consent: !!session.consent });
    // ---- согласие с условиями (после каждого входа) ----
    if (url.pathname === '/api/consent' && req.method === 'POST') {
      session.consent = true;
      const users = auth.readUsers();
      if (users[session.user]) { users[session.user].consentAt = new Date().toISOString(); auth.writeUsers(users); }
      console.log(new Date().toISOString(), `Согласие с условиями: ${session.user}`);
      return send(res, 200, { ok: true });
    }
    if (url.pathname.startsWith('/api/') && !session.consent) return send(res, 403, { error: 'Нужно подтвердить условия использования', consent: false });
    if (url.pathname === '/api/stock' && req.method === 'GET') {
      return send(res, 200, await getView(url.searchParams));
    }
    if (url.pathname === '/api/norms' && req.method === 'POST') {
      if (session.role !== 'admin') return send(res, 403, { error: 'Задавать нормы может только администратор' });
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.key || typeof body.key !== 'string') return send(res, 400, { error: 'Нет ключа позиции' });
      const norms = readNorms();
      const n = Number(body.norm);
      if (body.norm === null || body.norm === '' || !(n > 0)) delete norms[body.key];
      else norms[body.key] = n;
      writeNorms(norms);
      console.log(new Date().toISOString(), `Норма: ${body.key} = ${norms[body.key] ?? 'удалена'} (${session.user})`);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/report.csv' && req.method === 'GET') {
      const view = await getView(url.searchParams);
      const onlyOrder = url.searchParams.get('type') === 'order';
      const name = `${onlyOrder ? 'k-zakazu' : 'ostatki'}_${new Date().toISOString().slice(0, 10)}.csv`;
      return send(res, 200, toCsv(view, onlyOrder), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${name}"` });
    }
    // ---- пароль текущего пользователя ----
    if (url.pathname === '/api/password' && req.method === 'POST') {
      const b = await jsonBody(req);
      const users = auth.readUsers(); const u = users[session.user];
      if (!u || !auth.checkPassword(u, b.old)) return send(res, 400, { error: 'Текущий пароль неверный' });
      if (String(b.password || '').length < 8) return send(res, 400, { error: 'Новый пароль — не короче 8 символов' });
      Object.assign(u, auth.hashPassword(b.password)); auth.writeUsers(users);
      console.log(new Date().toISOString(), `Смена пароля: ${session.user}`);
      return send(res, 200, { ok: true });
    }
    // ---- пользователи (только администратор) ----
    if (url.pathname.startsWith('/api/users')) {
      if (session.role !== 'admin') return send(res, 403, { error: 'Только для администратора' });
      const users = auth.readUsers();
      if (req.method === 'GET') {
        return send(res, 200, Object.entries(users).map(([login, u]) => ({ login, name: u.name, role: u.role, disabled: !!u.disabled, last: u.last || null, consentAt: u.consentAt || null })));
      }
      const b = await jsonBody(req);
      const login = String(b.login || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,32}$/.test(login)) return send(res, 400, { error: 'Логин: 3–32 латинские буквы, цифры, точка, дефис' });
      if (url.pathname === '/api/users' && req.method === 'POST') {
        if (users[login]) return send(res, 400, { error: 'Такой логин уже есть' });
        if (String(b.password || '').length < 8) return send(res, 400, { error: 'Пароль — не короче 8 символов' });
        const role = b.role === 'admin' ? 'admin' : 'viewer';
        users[login] = { ...auth.hashPassword(b.password), role, name: String(b.name || login).slice(0, 80), disabled: false };
        auth.writeUsers(users);
        console.log(new Date().toISOString(), `Пользователь создан: ${login} (${role}) — ${session.user}`);
        return send(res, 200, { ok: true });
      }
      if (!users[login]) return send(res, 404, { error: 'Нет такого пользователя' });
      if (url.pathname === '/api/users/toggle' && req.method === 'POST') {
        if (login === session.user) return send(res, 400, { error: 'Нельзя заблокировать самого себя' });
        users[login].disabled = !users[login].disabled; auth.writeUsers(users);
        if (users[login].disabled) auth.dropSessions(login);
        console.log(new Date().toISOString(), `Пользователь ${login}: ${users[login].disabled ? 'заблокирован' : 'разблокирован'} — ${session.user}`);
        return send(res, 200, { ok: true, disabled: users[login].disabled });
      }
      if (url.pathname === '/api/users/password' && req.method === 'POST') {
        if (String(b.password || '').length < 8) return send(res, 400, { error: 'Пароль — не короче 8 символов' });
        Object.assign(users[login], auth.hashPassword(b.password)); auth.writeUsers(users);
        auth.dropSessions(login);
        console.log(new Date().toISOString(), `Пароль сброшен: ${login} — ${session.user}`);
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/users/delete' && req.method === 'POST') {
        if (login === session.user) return send(res, 400, { error: 'Нельзя удалить самого себя' });
        const admins = Object.entries(users).filter(([, u]) => u.role === 'admin' && !u.disabled).length;
        if (users[login].role === 'admin' && admins <= 1) return send(res, 400, { error: 'Нельзя удалить последнего администратора' });
        delete users[login]; auth.writeUsers(users); auth.dropSessions(login);
        console.log(new Date().toISOString(), `Пользователь удалён: ${login} — ${session.user}`);
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'Нет такого метода' });
    }
    // ---- пороги ----
    if (url.pathname === '/api/settings' && req.method === 'POST') {
      if (session.role !== 'admin') return send(res, 403, { error: 'Только для администратора' });
      const b = await jsonBody(req);
      const r = Math.round(Number(b.red)), y = Math.round(Number(b.yellow)), x = Math.round(Number(b.exp));
      if (!(r >= 1 && y > r && y <= 100 && x >= 1 && x <= 730)) return send(res, 400, { error: 'Проверьте значения: 1 ≤ красный < жёлтый ≤ 100, срок 1–730 дней' });
      saveSettings({ red: r, yellow: y, exp: x });
      console.log(new Date().toISOString(), `Пороги: ${r}/${y}%, срок ${x} дн. — ${session.user}`);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/health') return send(res, 200, { ok: true, onecUrl: CFG.onecUrl });
    // статика
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    file = path.normalize(path.join(PUBLIC_DIR, file));
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    console.error(new Date().toISOString(), e.message);
    return send(res, 502, { error: e.message });
  }
});

// Фоновое обновление из 1С каждые REFRESH_MINUTES минут (по умолчанию 10) — данные всегда свежие
const REFRESH_MIN = Math.max(1, Number(env.REFRESH_MINUTES || 10));
async function backgroundRefresh() {
  try { await fetchStock(true); console.log(new Date().toISOString(), 'Автообновление из 1С: ок'); }
  catch (e) { console.warn(new Date().toISOString(), 'Автообновление из 1С: ' + e.message); }
}
setInterval(backgroundRefresh, REFRESH_MIN * 60000);
setTimeout(backgroundRefresh, 5000);

server.listen(CFG.port, CFG.host, () => {
  console.log(`Остатки: http://localhost:${CFG.port}  (1С: ${CFG.onecUrl}, пользователь 1С: ${CFG.onecUser || 'не задан'})`);
  if (!Object.keys(auth.readUsers()).length) {
    console.warn('ВНИМАНИЕ: нет ни одного пользователя веб-интерфейса. Создайте: node users.js add admin admin "Администратор"');
  }
});
