// Отдельная супер-админ панель для IDEAL Lab: не связана с обычным входом
// сотрудников по PIN-коду или регистрацией врача по телефону (см. server.js
// и public/index.html) — доступ по логину/паролю из переменных окружения
// SUPERADMIN_LOGIN / SUPERADMIN_PASSWORD (Railway), как и в остальных
// системах "Пульта клиник". У IDEAL Lab нет ни таблицы запросов, ни готовой
// БД — источник данных для активности/ошибок пишем сами (см. requestLogger
// ниже), а "клиенты" и "лечение" переводятся в термины лаборатории: клиент —
// это врач/клиника (коллекция doctors), лечение — выполненный заказ (orders),
// оплата — запись в payments, привязанная к заказу через orderId.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const store = require('./store');

const router = express.Router();

const sessions = new Map(); // token -> createdAt (мс)
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const LOG_FILE = path.join(store.DATA_DIR, 'superadmin-log.json');
const MAX_LOG_ENTRIES = 5000;

let log = [];
if (fs.existsSync(LOG_FILE)) {
  try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); }
  catch (e) { console.error('Failed to parse superadmin-log.json, starting fresh:', e.message); log = []; }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = LOG_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(log), (err) => {
      if (err) { console.error('superadmin log save failed', err); return; }
      fs.rename(tmp, LOG_FILE, (err2) => { if (err2) console.error('superadmin log rename failed', err2); });
    });
  }, 150);
}

function pushLogEntry(entry) {
  log.push(entry);
  if (log.length > MAX_LOG_ENTRIES) log.splice(0, log.length - MAX_LOG_ENTRIES);
  scheduleSave();
}

// Подключить в server.js ДО статики/API, чтобы видеть все запросы.
function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path === '/api/health') return; // не засоряем журнал health-чеками
    pushLogEntry({
      created_at: new Date().toISOString(),
      method: req.method,
      path: req.path,
      status_code: res.statusCode,
      duration_ms: Date.now() - start,
      ip: req.ip
    });
  });
  next();
}

function getCredentials() {
  return { login: process.env.SUPERADMIN_LOGIN, password: process.env.SUPERADMIN_PASSWORD };
}

function requireSuperadmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const createdAt = token && sessions.get(token);
  if (!createdAt) return res.status(401).json({ error: 'unauthorized', message: 'Не авторизован' });
  if (Date.now() - createdAt > TOKEN_TTL_MS) {
    sessions.delete(token);
    return res.status(401).json({ error: 'unauthorized', message: 'Сессия истекла, войдите заново' });
  }
  next();
}

router.post('/login', (req, res) => {
  const { login, password } = getCredentials();
  if (!login || !password) {
    return res.status(503).json({
      error: 'not_configured',
      message: 'Супер-админ панель не настроена (нет SUPERADMIN_LOGIN/SUPERADMIN_PASSWORD на сервере)'
    });
  }
  const { username, password: pw } = req.body || {};
  if (String(username || '').trim() !== login || pw !== password) {
    return res.status(401).json({ error: 'unauthorized', message: 'Неверный логин или пароль' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now());
  res.json({ token });
});

router.post('/logout', requireSuperadmin, (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  sessions.delete(token);
  res.json({ ok: true });
});

router.get('/overview', requireSuperadmin, (req, res) => {
  const now = Date.now();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  const doctors = store.listCollection('doctors');
  const orders = store.listCollection('orders');
  const payments = store.listCollection('payments');
  const staff = store.listCollection('staff');

  const requestsToday = log.filter((r) => new Date(r.created_at).getTime() >= todayStart.getTime()).length;
  const requestsWeek = log.filter((r) => new Date(r.created_at).getTime() >= weekAgo).length;
  const errorsToday = log.filter((r) => r.status_code >= 400 && new Date(r.created_at).getTime() >= todayStart.getTime()).length;
  const ordersToday = orders.filter((o) => {
    const t = o.data && o.data.createdAt ? new Date(o.data.createdAt).getTime() : 0;
    return t >= todayStart.getTime();
  }).length;

  res.json({
    doctors_total: doctors.length,
    staff_total: staff.length,
    orders_total: orders.length,
    orders_today: ordersToday,
    payments_total: payments.length,
    requests_today: requestsToday,
    requests_week: requestsWeek,
    errors_today: errorsToday
  });
});

const ACTION_RULES = [
  [/^POST$/, /^\/api\/doc\/orders$/, 'Создан заказ'],
  [/^PATCH$/, /^\/api\/doc\/orders\/[^/]+$/, 'Изменён заказ'],
  [/^PUT$/, /^\/api\/doc\/orders\/[^/]+$/, 'Изменён заказ'],
  [/^DELETE$/, /^\/api\/doc\/orders\/[^/]+$/, 'Удалён заказ'],
  [/^POST$/, /^\/api\/doc\/payments$/, 'Добавлена оплата'],
  [/^POST$/, /^\/api\/doc\/doctors$/, 'Регистрация врача/клиники'],
  [/^PATCH$/, /^\/api\/doc\/doctors\/[^/]+$/, 'Изменён врач/клиника'],
  [/^POST$/, /^\/api\/doc\/staff$/, 'Добавлен сотрудник'],
  [/^POST$/, /^\/api\/doc\/expenses$/, 'Добавлен расход'],
  [/^POST$/, /^\/api\/doc\/timeoff$/, 'Заявка на отгул/отпуск']
];

function labelFor(method, p) {
  for (const [m, r, label] of ACTION_RULES) {
    if (m.test(method) && r.test(p)) return label;
  }
  return method + ' ' + p;
}

router.get('/activity', requireSuperadmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '150', 10), 500);
  const rows = log
    .filter((r) => ['POST', 'PUT', 'PATCH', 'DELETE'].indexOf(r.method) !== -1)
    .slice(-limit)
    .reverse();
  res.json(rows.map((r) => ({
    created_at: r.created_at,
    label: labelFor(r.method, r.path),
    method: r.method,
    path: r.path,
    status_code: r.status_code
  })));
});

router.get('/errors', requireSuperadmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
  const rows = log
    .filter((r) => r.status_code >= 400)
    .slice(-limit)
    .reverse();
  res.json(rows.map((r) => ({
    created_at: r.created_at,
    method: r.method,
    path: r.path,
    status_code: r.status_code,
    ip: r.ip
  })));
});

// "Клиенты" лаборатории — это врачи/клиники (коллекция doctors), а не
// пациенты: IDEAL Lab работает с зубными техниками и врачами, которые
// присылают заказы. "Лечение" — выполненные заказы (orders, привязка по
// doctorPhone === id доктора), "оплата" — payments, привязанные к заказу
// через orderId (см. схему в public/index.html: state.db.collection(...)).
router.get('/clients', requireSuperadmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '300', 10), 2000);

  const doctors = store.listCollection('doctors');
  const orders = store.listCollection('orders');
  const payments = store.listCollection('payments');

  const result = doctors.slice(0, limit).map(({ id, data: doc }) => {
    const myOrders = orders.filter((o) => o.data && o.data.doctorPhone === id);
    const myOrderIds = new Set(myOrders.map((o) => o.id));
    const myPayments = payments.filter((p) => p.data && myOrderIds.has(p.data.orderId));

    const totalInvoiced = myOrders.reduce((sum, o) => sum + (Number(o.data.total) || 0), 0);
    const totalPaid = myPayments.reduce((sum, p) => sum + (Number(p.data.amount) || 0), 0);

    const sortedOrders = myOrders.slice().sort((a, b) => {
      const ad = a.data.createdAt ? new Date(a.data.createdAt).getTime() : 0;
      const bd = b.data.createdAt ? new Date(b.data.createdAt).getTime() : 0;
      return bd - ad;
    });
    const lastVisit = sortedOrders.length ? sortedOrders[0].data.createdAt : null;

    return {
      id,
      name: doc.name || doc.clinicName || id,
      phone: doc.phone || id,
      total_paid: totalPaid,
      total_invoiced: totalInvoiced,
      last_visit: lastVisit,
      treatments: sortedOrders.slice(0, 10).map((o) => ({
        description: (o.data.patientName ? o.data.patientName + ': ' : '') + (o.data.code || 'заказ'),
        price: o.data.total,
        performed_at: o.data.createdAt
      }))
    };
  });

  res.json(result);
});

module.exports = { router, requestLogger };
