// Серверная авторизация для IDEAL Lab.
//
// Модель: PIN сотрудника / телефон врача проверяются НА СЕРВЕРЕ, в ответ
// выдаётся подписанный (HMAC-SHA256) токен с привязкой к staffId / doctorId.
// Токен передаётся в заголовке `Authorization: Bearer …`. Роль и активность
// сотрудника при каждом запросе перечитываются из хранилища, поэтому
// деактивация/смена роли/смена PIN действуют сразу, без ожидания истечения токена.
//
// PIN хранится только как scrypt-хэш (`pinHash`), поле `pin` из документов
// сотрудников удаляется (миграция при старте) и клиентам никогда не отдаётся.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');

// ---------- секрет подписи ----------
function loadSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  const f = path.join(store.DATA_DIR, 'auth-secret.key');
  try {
    if (fs.existsSync(f)) {
      const v = fs.readFileSync(f, 'utf8').trim();
      if (v.length >= 32) return v;
    }
  } catch (e) { /* создадим новый */ }
  const v = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(f, v, { mode: 0o600 });
  return v;
}
const SECRET = loadSecret();
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function b64u(buf) { return Buffer.from(buf).toString('base64url'); }
function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const i = token.indexOf('.');
  if (i < 1) return null;
  const body = token.slice(0, i), sig = token.slice(i + 1);
  const exp = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(exp);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!p || !p.exp || p.exp < Date.now()) return null;
  return p;
}

// ---------- PIN ----------
function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pin), salt, 32);
  return 's1$' + salt.toString('hex') + '$' + h.toString('hex');
}
function checkPin(pin, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 's1') return false;
  const salt = Buffer.from(parts[1], 'hex'), want = Buffer.from(parts[2], 'hex');
  const got = crypto.scryptSync(String(pin), salt, want.length);
  return crypto.timingSafeEqual(got, want);
}
function isValidPin(pin) { return typeof pin === 'string' && /^[0-9]{4}$/.test(pin); }

// Миграция: открытый `pin` -> `pinHash`.
function migratePins() {
  let n = 0;
  store.listCollection('staff').forEach((r) => {
    if (r.data.pin !== undefined) {
      const d = Object.assign({}, r.data);
      if (isValidPin(String(d.pin)) && !d.pinHash) d.pinHash = hashPin(String(d.pin));
      delete d.pin;
      store.setDoc('staff/' + r.id, d);
      n++;
    }
  });
  if (n) console.log('Auth: migrated ' + n + ' staff PIN(s) to hashed storage');
}

// ---------- ограничение перебора ----------
const attempts = new Map(); // key -> {count, first, lockedUntil}
const MAX_FAILS = 5, WINDOW_MS = 10 * 60 * 1000, LOCK_MS = 10 * 60 * 1000;
function lockedFor(key) {
  const a = attempts.get(key);
  if (!a) return 0;
  if (a.lockedUntil && a.lockedUntil > Date.now()) return a.lockedUntil - Date.now();
  if (Date.now() - a.first > WINDOW_MS) attempts.delete(key);
  return 0;
}
function noteFail(key) {
  const now = Date.now();
  let a = attempts.get(key);
  if (!a || now - a.first > WINDOW_MS) a = { count: 0, first: now, lockedUntil: 0 };
  a.count++;
  if (a.count >= MAX_FAILS) a.lockedUntil = now + LOCK_MS;
  attempts.set(key, a);
}
function clearFails(key) { attempts.delete(key); }
setInterval(() => {
  const now = Date.now();
  attempts.forEach((a, k) => { if (now - a.first > WINDOW_MS && (!a.lockedUntil || a.lockedUntil < now)) attempts.delete(k); });
}, 5 * 60 * 1000).unref();

// ---------- пользователи ----------
function publicStaff(id, d) {
  const o = Object.assign({}, d);
  delete o.pin; delete o.pinHash;
  o.id = id;
  return o;
}
function issueStaffToken(id, d) {
  return sign({ t: 'staff', id, pv: String(d.pinHash || '').slice(-8), exp: Date.now() + TOKEN_TTL_MS });
}
function issueDoctorToken(id) {
  return sign({ t: 'doctor', id, exp: Date.now() + TOKEN_TTL_MS });
}

// Возвращает {type, id, role?, doc} или null.
function userFromToken(token) {
  const p = verifyToken(token);
  if (!p) return null;
  if (p.t === 'staff') {
    const d = store.getDoc('staff/' + p.id);
    if (!d || d.active === false) return null;
    if (String(d.pinHash || '').slice(-8) !== p.pv) return null; // PIN сменён — токен недействителен
    return { type: 'staff', id: p.id, role: d.role, doc: d };
  }
  if (p.t === 'doctor') {
    const d = store.getDoc('doctors/' + p.id);
    if (!d) return null;
    return { type: 'doctor', id: p.id, doc: d };
  }
  return null;
}
function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}
function authenticate(req, res, next) {
  const u = userFromToken(bearer(req));
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  req.user = u;
  next();
}

// ---------- политика доступа ----------
const COLLECTIONS = ['staff', 'doctors', 'orders', 'payments', 'expenses', 'timeoff', 'settings', 'activity', 'pushSubscriptions'];
const PUBLIC_SETTINGS = ['config', 'priceList']; // единственные settings-документы, доступные через API (vapid содержит приватный ключ!)
const MONEY_ROLES = ['owner', 'admin', 'accountant'];
const ORDER_PRICING_KEYS = ['items', 'total', 'subtotal', 'unitsTotal', 'urgent'];
const isStaff = (u) => u.type === 'staff';
const isAdminLike = (u) => isStaff(u) && (u.role === 'admin' || u.role === 'owner');
const isOwner = (u) => isStaff(u) && u.role === 'owner';
const hasMoney = (u) => isStaff(u) && MONEY_ROLES.indexOf(u.role) > -1;

function doctorOrderIds(doctorId) {
  return store.listCollection('orders').filter((r) => r.data.doctorPhone === doctorId).map((r) => r.id);
}

// Может ли пользователь читать документ (data — содержимое, id — id документа)
function canReadDoc(u, coll, id, data) {
  if (coll === 'settings') return PUBLIC_SETTINGS.indexOf(id) > -1;
  if (coll === 'pushSubscriptions') return false; // только сервер
  if (isStaff(u)) {
    if (coll === 'payments' || coll === 'expenses') return hasMoney(u);
    if (coll === 'activity') return isAdminLike(u);
    return true;
  }
  // врач
  if (coll === 'orders') return !!data && data.doctorPhone === u.id;
  if (coll === 'doctors') return id === u.id;
  if (coll === 'payments') return !!data && doctorOrderIds(u.id).indexOf(data.orderId) > -1;
  return false;
}
function collectionReadable(u, coll) {
  if (coll === 'settings' || coll === 'pushSubscriptions') return false;
  if (isStaff(u)) return coll === 'payments' || coll === 'expenses' ? hasMoney(u) : coll === 'activity' ? isAdminLike(u) : true;
  return ['orders', 'doctors', 'payments'].indexOf(coll) > -1;
}
function sanitizeOut(coll, id, data) {
  if (coll === 'staff') { const o = Object.assign({}, data); delete o.pin; delete o.pinHash; return o; }
  return data;
}

// Проверка записи. method: POST|PUT|PATCH|DELETE. Возвращает null (можно) или строку-причину отказа.
// body может быть изменён (принудительные поля).
function checkWrite(u, method, coll, id, body, existing) {
  if (COLLECTIONS.indexOf(coll) === -1) return 'unknown_collection';
  if (coll === 'settings') {
    if (PUBLIC_SETTINGS.indexOf(id) === -1) return 'forbidden';
    return isAdminLike(u) ? null : 'forbidden';
  }
  if (u.type === 'doctor') {
    if (coll === 'activity' && method === 'POST') return null;
    if (coll === 'orders' && method === 'POST') {
      if (!body || body.doctorPhone !== u.id) return 'forbidden';
      // врач не может сам назначить этап/исполнителей/выплаты
      const cfg = store.getDoc('settings/config') || {};
      body.stage = (cfg.stages && cfg.stages[0]) || 'Новый';
      body.assignedStaffId = null; body.assignedMillerId = null;
      body.techPayout = null; body.millerPayout = null; body.demo = false;
      body.createdBy = { type: 'doctor', name: u.doc.name };
      return null;
    }
    return 'forbidden';
  }
  // --- сотрудники ---
  switch (coll) {
    case 'orders':
      if (method === 'DELETE') return isOwner(u) ? null : 'forbidden';
      // состав заказа и сумму (позиции, итоги, срочность) меняют только админ/владелец
      if ((method === 'PATCH' || method === 'PUT') && !isAdminLike(u)) {
        const ex = existing || {};
        const same = (k) => JSON.stringify(body[k]) === JSON.stringify(ex[k]);
        const keys = ORDER_PRICING_KEYS.filter((k) => (method === 'PUT' ? true : body[k] !== undefined));
        if (!keys.every(same)) return 'forbidden';
      }
      return null;
    case 'payments':
    case 'expenses':
      return hasMoney(u) ? null : 'forbidden';
    case 'timeoff': {
      if (isAdminLike(u)) return null;
      const sid = method === 'POST' || method === 'PUT' ? (body && body.staffId) : (existing && existing.staffId);
      return sid === u.id ? null : 'forbidden';
    }
    case 'doctors':
      if (method === 'DELETE') return isAdminLike(u) ? null : 'forbidden';
      return null;
    case 'activity':
      return method === 'POST' ? null : 'forbidden';
    case 'pushSubscriptions':
      if (method === 'POST') { if (body) body.staffId = u.id; return null; }
      if (method === 'DELETE') return existing && existing.staffId === u.id ? null : 'forbidden';
      return 'forbidden';
    case 'staff': {
      if (method === 'POST' || method === 'DELETE') { if (!isOwner(u)) return 'forbidden'; }
      else if (!isAdminLike(u)) return 'forbidden';
      // админ не может трогать владельца и назначать роль owner
      if (!isOwner(u)) {
        if (existing && existing.role === 'owner') return 'forbidden';
        if (body && body.role === 'owner') return 'forbidden';
      }
      return null;
    }
  }
  return 'forbidden';
}

// Приводит запись сотрудника к хранимому виду: pin -> pinHash. Возвращает строку-ошибку или null.
function prepareStaffBody(method, body, existing) {
  if (!body) return null;
  if (body.pinHash !== undefined) delete body.pinHash; // клиент не может задать хэш напрямую
  if (body.pin !== undefined && body.pin !== '' && body.pin !== null) {
    if (!isValidPin(String(body.pin))) return 'invalid_pin';
    body.pinHash = hashPin(String(body.pin));
  } else if (method === 'POST') {
    return 'invalid_pin';
  }
  delete body.pin;
  if (method === 'PUT' && !body.pinHash && existing && existing.pinHash) body.pinHash = existing.pinHash;
  return null;
}

module.exports = {
  hashPin, checkPin, isValidPin, migratePins,
  sign, verifyToken, userFromToken, authenticate, bearer,
  issueStaffToken, issueDoctorToken, publicStaff,
  lockedFor, noteFail, clearFails,
  COLLECTIONS, PUBLIC_SETTINGS, MONEY_ROLES,
  canReadDoc, collectionReadable, sanitizeOut, checkWrite, prepareStaffBody,
  isAdminLike, isOwner, hasMoney, isStaff, doctorOrderIds
};
